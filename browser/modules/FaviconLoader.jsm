/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = ["FaviconLoader"];

ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");
ChromeUtils.import("resource://gre/modules/Services.jsm");

XPCOMUtils.defineLazyGlobalGetters(this, ["Blob", "FileReader"]);

ChromeUtils.defineModuleGetter(this, "DeferredTask",
  "resource://gre/modules/DeferredTask.jsm");
ChromeUtils.defineModuleGetter(this, "PromiseUtils",
  "resource://gre/modules/PromiseUtils.jsm");

const BinaryInputStream = Components.Constructor("@mozilla.org/binaryinputstream;1",
                                                 "nsIBinaryInputStream", "setInputStream");

const SIZES_TELEMETRY_ENUM = {
  NO_SIZES: 0,
  ANY: 1,
  DIMENSION: 2,
  INVALID: 3,
};

const FAVICON_PARSING_TIMEOUT = 100;
const FAVICON_RICH_ICON_MIN_WIDTH = 96;
const PREFERRED_WIDTH = 16;

// URL schemes that we don't want to load and convert to data URLs.
const LOCAL_FAVICON_SCHEMES = [
  "chrome",
  "about",
  "resource",
  "data",
];

const MAX_FAVICON_EXPIRATION = 7 * 24 * 60 * 60 * 1000;

const TYPE_ICO = "image/x-icon";
const TYPE_SVG = "image/svg+xml";

function promiseBlobAsDataURL(blob) {
  return new Promise((resolve, reject) => {
    let reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", reject);
    reader.readAsDataURL(blob);
  });
}

function promiseBlobAsOctets(blob) {
  return new Promise((resolve, reject) => {
    let reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(Array.from(reader.result).map(c => c.charCodeAt(0)));
    });
    reader.addEventListener("error", reject);
    reader.readAsBinaryString(blob);
  });
}

class FaviconLoad {
  constructor(iconInfo) {
    this.buffers = [];
    this.icon = iconInfo;

    this.channel = Services.io.newChannelFromURI2(
      iconInfo.iconUri,
      iconInfo.node,
      iconInfo.node.nodePrincipal,
      iconInfo.node.nodePrincipal,
      (Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_DATA_INHERITS |
       Ci.nsILoadInfo.SEC_ALLOW_CHROME |
       Ci.nsILoadInfo.SEC_DISALLOW_SCRIPT),
      Ci.nsIContentPolicy.TYPE_INTERNAL_IMAGE_FAVICON);

    this.channel.loadFlags |= Ci.nsIRequest.LOAD_BACKGROUND;
    // Sometimes node is a document and sometimes it is an element. This is
    // the easiest single way to get to the load group in both those cases.
    this.channel.loadGroup = iconInfo.node.ownerGlobal.document.documentLoadGroup;
    this.channel.notificationCallbacks = this;

    if (Services.prefs.getBoolPref("network.http.tailing.enabled", true) &&
        this.channel instanceof Ci.nsIClassOfService) {
      this.channel.addClassFlags(Ci.nsIClassOfService.Tail | Ci.nsIClassOfService.Throttleable);
    }
  }

  load() {
    this._deferred = PromiseUtils.defer();
    // Clear the channel reference when we succeed or fail.
    this._deferred.promise.then(
      () => this.channel = null,
      () => this.channel = null
    );

    try {
      this.channel.asyncOpen2(this);
    } catch (e) {
      this._deferred.reject(e);
    }

    return this._deferred.promise;
  }

  cancel() {
    if (!this.channel) {
      return;
    }

    this.channel.cancel(Cr.NS_BINDING_ABORTED);
  }

  onStartRequest(request, context) {
  }

  onDataAvailable(request, context, inputStream, offset, count) {
    let stream = new BinaryInputStream(inputStream);
    let buffer = new ArrayBuffer(count);
    stream.readArrayBuffer(buffer.byteLength, buffer);
    this.buffers.push(new Uint8Array(buffer));
  }

  asyncOnChannelRedirect(oldChannel, newChannel, flags, callback) {
    if (oldChannel == this.channel) {
      this.channel = newChannel;
    }

    callback.onRedirectVerifyCallback(Cr.NS_OK);
  }

  async onStopRequest(request, context, statusCode) {
    if (request != this.channel) {
      // Indicates that a redirect has occurred. We don't care about the result
      // of the original channel.
      return;
    }

    if (!Components.isSuccessCode(statusCode)) {
      if (statusCode == Cr.NS_BINDING_ABORTED) {
        this._deferred.reject(Components.Exception(`Favicon load from ${this.icon.iconUri.spec} was cancelled.`, statusCode));
      } else {
        this._deferred.reject(Components.Exception(`Favicon at "${this.icon.iconUri.spec}" failed to load.`, statusCode));
      }
      return;
    }

    if (this.channel instanceof Ci.nsIHttpChannel) {
      if (!this.channel.requestSucceeded) {
        this._deferred.reject(Components.Exception(`Favicon at "${this.icon.iconUri.spec}" failed to load: ${this.channel.responseStatusText}.`, Cr.NS_ERROR_FAILURE));
        return;
      }
    }

    // Attempt to get an expiration time from the cache.  If this fails, we'll
    // use this default.
    let expiration = Date.now() + MAX_FAVICON_EXPIRATION;

    // This stuff isn't available after onStopRequest returns (so don't start
    // any async operations before this!).
    if (this.channel instanceof Ci.nsICacheInfoChannel) {
      try {
        expiration = Math.min(this.channel.cacheTokenExpirationTime * 1000, expiration);
      } catch (e) {
        // Ignore failures to get the expiration time.
      }
    }

    try {
      let type = this.channel.contentType;
      let blob = new Blob(this.buffers, { type });

      if (type != "image/svg+xml") {
        let octets = await promiseBlobAsOctets(blob);
        let sniffer = Cc["@mozilla.org/image/loader;1"].
                      createInstance(Ci.nsIContentSniffer);
        type = sniffer.getMIMETypeFromContent(this.channel, octets, octets.length);

        if (!type) {
          throw Components.Exception(`Favicon at "${this.icon.iconUri.spec}" did not match a known mimetype.`, Cr.NS_ERROR_FAILURE);
        }

        blob = blob.slice(0, blob.size, type);
      }

      let dataURL = await promiseBlobAsDataURL(blob);

      this._deferred.resolve({
        expiration,
        dataURL,
      });
    } catch (e) {
      this._deferred.reject(e);
    }
  }

  getInterface(iid) {
    if (iid.equals(Ci.nsIChannelEventSink)) {
      return this;
    }
    throw Cr.NS_ERROR_NO_INTERFACE;
  }
}

/*
 * Extract the icon width from the size attribute. It also sends the telemetry
 * about the size type and size dimension info.
 *
 * @param {Array} aSizes An array of strings about size.
 * @return {Number} A width of the icon in pixel.
 */
function extractIconSize(aSizes) {
  let width = -1;
  let sizesType;
  const re = /^([1-9][0-9]*)x[1-9][0-9]*$/i;

  if (aSizes.length) {
    for (let size of aSizes) {
      if (size.toLowerCase() == "any") {
        sizesType = SIZES_TELEMETRY_ENUM.ANY;
        break;
      } else {
        let values = re.exec(size);
        if (values && values.length > 1) {
          sizesType = SIZES_TELEMETRY_ENUM.DIMENSION;
          width = parseInt(values[1]);
          break;
        } else {
          sizesType = SIZES_TELEMETRY_ENUM.INVALID;
          break;
        }
      }
    }
  } else {
    sizesType = SIZES_TELEMETRY_ENUM.NO_SIZES;
  }

  // Telemetry probes for measuring the sizes attribute
  // usage and available dimensions.
  Services.telemetry.getHistogramById("LINK_ICON_SIZES_ATTR_USAGE").add(sizesType);
  if (width > 0)
    Services.telemetry.getHistogramById("LINK_ICON_SIZES_ATTR_DIMENSION").add(width);

  return width;
}

/*
 * Get link icon URI from a link dom node.
 *
 * @param {DOMNode} aLink A link dom node.
 * @return {nsIURI} A uri of the icon.
 */
function getLinkIconURI(aLink) {
  let targetDoc = aLink.ownerDocument;
  let uri = Services.io.newURI(aLink.href, targetDoc.characterSet);
  try {
    uri = uri.mutate().setUserPass("").finalize();
  } catch (e) {
    // some URIs are immutable
  }
  return uri;
}

/**
 * Guess a type for an icon based on its declared type or file extension.
 */
function guessType(icon) {
  // No type with no icon
  if (!icon) {
    return "";
  }

  // Use the file extension to guess at a type we're interested in
  if (!icon.type) {
    let extension = icon.iconUri.filePath.split(".").pop();
    switch (extension) {
      case "ico":
        return TYPE_ICO;
      case "svg":
        return TYPE_SVG;
    }
  }

  // Fuzzily prefer the type or fall back to the declared type
  return icon.type == "image/vnd.microsoft.icon" ? TYPE_ICO : icon.type || "";
}

/*
 * Selects the best rich icon and tab icon from a list of IconInfo objects.
 *
 * @param {Array} iconInfos A list of IconInfo objects.
 * @param {integer} preferredWidth The preferred width for tab icons.
 */
function selectIcons(iconInfos, preferredWidth) {
  if (iconInfos.length == 0) {
    return {
      richIcon: null,
      tabIcon: null,
    };
  }

  let preferredIcon;
  let bestSizedIcon;
  // Other links with the "icon" tag are the default icons
  let defaultIcon;
  // Rich icons are either apple-touch or fluid icons, or the ones of the
  // dimension 96x96 or greater
  let largestRichIcon;

  for (let icon of iconInfos) {
    if (!icon.isRichIcon) {
      // First check for svg. If it's not available check for an icon with a
      // size adapt to the current resolution. If both are not available, prefer
      // ico files. When multiple icons are in the same set, the latest wins.
      if (guessType(icon) == TYPE_SVG) {
        preferredIcon = icon;
      } else if (icon.width == preferredWidth && guessType(preferredIcon) != TYPE_SVG) {
        preferredIcon = icon;
      } else if (guessType(icon) == TYPE_ICO && (!preferredIcon || guessType(preferredIcon) == TYPE_ICO)) {
        preferredIcon = icon;
      }

      // Check for an icon larger yet closest to preferredWidth, that can be
      // downscaled efficiently.
      if (icon.width >= preferredWidth &&
          (!bestSizedIcon || bestSizedIcon.width >= icon.width)) {
        bestSizedIcon = icon;
      }
    }

    // Note that some sites use hi-res icons without specifying them as
    // apple-touch or fluid icons.
    if (icon.isRichIcon || icon.width >= FAVICON_RICH_ICON_MIN_WIDTH) {
      if (!largestRichIcon || largestRichIcon.width < icon.width) {
        largestRichIcon = icon;
      }
    } else {
      defaultIcon = icon;
    }
  }

  // Now set the favicons for the page in the following order:
  // 1. Set the best rich icon if any.
  // 2. Set the preferred one if any, otherwise check if there's a better
  //    sized fit.
  // This order allows smaller icon frames to eventually override rich icon
  // frames.

  let tabIcon = null;
  if (preferredIcon) {
    tabIcon = preferredIcon;
  } else if (bestSizedIcon) {
    tabIcon = bestSizedIcon;
  } else if (defaultIcon) {
    tabIcon = defaultIcon;
  }

  return {
    richIcon: largestRichIcon,
    tabIcon
  };
}

class IconLoader {
  constructor(mm) {
    this.mm = mm;
  }

  async load(iconInfo) {
    if (this._loader) {
      this._loader.cancel();
    }

    if (LOCAL_FAVICON_SCHEMES.includes(iconInfo.iconUri.scheme)) {
      this.mm.sendAsyncMessage("Link:SetIcon", {
        originalURL: iconInfo.iconUri.spec,
        canUseForTab: !iconInfo.isRichIcon,
        expiration: undefined,
        iconURL: iconInfo.iconUri.spec,
      });
      return;
    }

    try {
      this._loader = new FaviconLoad(iconInfo);
      let { dataURL, expiration } = await this._loader.load();

      this.mm.sendAsyncMessage("Link:SetIcon", {
        originalURL: iconInfo.iconUri.spec,
        canUseForTab: !iconInfo.isRichIcon,
        expiration,
        iconURL: dataURL,
      });
    } catch (e) {
      if (e.result != Cr.NS_BINDING_ABORTED) {
        Cu.reportError(e);

        // Used mainly for tests currently.
        this.mm.sendAsyncMessage("Link:SetFailedIcon", {
          originalURL: iconInfo.iconUri.spec,
          canUseForTab: !iconInfo.isRichIcon,
        });
      }
    } finally {
      this._loader = null;
    }
  }

  cancel() {
    if (!this._loader) {
      return;
    }

    this._loader.cancel();
    this._loader = null;
  }
}

class FaviconLoader {
  constructor(mm) {
    this.mm = mm;
    this.iconInfos = [];

    // For every page we attempt to find a rich icon and a tab icon. These
    // objects take care of the load process for each.
    this.richIconLoader = new IconLoader(mm);
    this.tabIconLoader = new IconLoader(mm);

    this.iconTask = new DeferredTask(() => this.loadIcons(), FAVICON_PARSING_TIMEOUT);
  }

  loadIcons() {
    let preferredWidth = PREFERRED_WIDTH * Math.ceil(this.mm.content.devicePixelRatio);
    let { richIcon, tabIcon } = selectIcons(this.iconInfos, preferredWidth);
    this.iconInfos = [];

    if (richIcon) {
      this.richIconLoader.load(richIcon);
    }

    if (tabIcon) {
      this.tabIconLoader.load(tabIcon);
    }
  }

  addIcon(iconInfo) {
    this.iconInfos.push(iconInfo);
    this.iconTask.arm();
  }

  addDefaultIcon(baseURI) {
    // Currently ImageDocuments will just load the default favicon, see bug
    // 403651 for discussion.
    this.addIcon({
      iconUri: baseURI.mutate().setPathQueryRef("/favicon.ico").finalize(),
      width: -1,
      isRichIcon: false,
      type: TYPE_ICO,
      node: this.mm.content.document,
    });
  }

  onPageShow() {
    // We're likely done with icon parsing so load the pending icons now.
    if (this.iconTask.isArmed) {
      this.iconTask.disarm();
      this.loadIcons();
    }
  }

  onPageHide() {
    this.richIconLoader.cancel();
    this.tabIconLoader.cancel();

    this.iconTask.disarm();
    this.iconInfos = [];
  }

  static makeFaviconFromLink(aLink, aIsRichIcon) {
    let iconUri = getLinkIconURI(aLink);
    if (!iconUri)
      return null;

    // Extract the size type and width.
    let width = extractIconSize(aLink.sizes);

    return {
      iconUri,
      width,
      isRichIcon: aIsRichIcon,
      type: aLink.type,
      node: aLink,
    };
  }
}
