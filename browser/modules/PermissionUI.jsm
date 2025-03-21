/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var EXPORTED_SYMBOLS = [
  "PermissionUI",
];

/**
 * PermissionUI is responsible for exposing both a prototype
 * PermissionPrompt that can be used by arbitrary browser
 * components and add-ons, but also hosts the implementations of
 * built-in permission prompts.
 *
 * If you're developing a feature that requires web content to ask
 * for special permissions from the user, this module is for you.
 *
 * Suppose a system add-on wants to add a new prompt for a new request
 * for getting more low-level access to the user's sound card, and the
 * permission request is coming up from content by way of the
 * nsContentPermissionHelper. The system add-on could then do the following:
 *
 * Cu.import("resource://gre/modules/Integration.jsm");
 * Cu.import("resource:///modules/PermissionUI.jsm");
 *
 * const SoundCardIntegration = (base) => ({
 *   __proto__: base,
 *   createPermissionPrompt(type, request) {
 *     if (type != "sound-api") {
 *       return super.createPermissionPrompt(...arguments);
 *     }
 *
 *     return {
 *       __proto__: PermissionUI.PermissionPromptForRequestPrototype,
 *       get permissionKey() {
 *         return "sound-permission";
 *       }
 *       // etc - see the documentation for PermissionPrompt for
 *       // a better idea of what things one can and should override.
 *     }
 *   },
 * });
 *
 * // Add-on startup:
 * Integration.contentPermission.register(SoundCardIntegration);
 * // ...
 * // Add-on shutdown:
 * Integration.contentPermission.unregister(SoundCardIntegration);
 *
 * Note that PermissionPromptForRequestPrototype must be used as the
 * prototype, since the prompt is wrapping an nsIContentPermissionRequest,
 * and going through nsIContentPermissionPrompt.
 *
 * It is, however, possible to take advantage of PermissionPrompt without
 * having to go through nsIContentPermissionPrompt or with a
 * nsIContentPermissionRequest. The PermissionPromptPrototype can be
 * imported, subclassed, and have prompt() called directly, without
 * the caller having called into createPermissionPrompt.
 */
ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");

ChromeUtils.defineModuleGetter(this, "Services",
  "resource://gre/modules/Services.jsm");
ChromeUtils.defineModuleGetter(this, "SitePermissions",
  "resource:///modules/SitePermissions.jsm");
ChromeUtils.defineModuleGetter(this, "PrivateBrowsingUtils",
  "resource://gre/modules/PrivateBrowsingUtils.jsm");

XPCOMUtils.defineLazyGetter(this, "gBrowserBundle", function() {
  return Services.strings
                 .createBundle("chrome://browser/locale/browser.properties");
});

var PermissionUI = {};

/**
 * PermissionPromptPrototype should be subclassed by callers that
 * want to display prompts to the user. See each method and property
 * below for guidance on what to override.
 *
 * Note that if you're creating a prompt for an
 * nsIContentPermissionRequest, you'll want to subclass
 * PermissionPromptForRequestPrototype instead.
 */
var PermissionPromptPrototype = {
  /**
   * Returns the associated <xul:browser> for the request. This should
   * work for the e10s and non-e10s case.
   *
   * Subclasses must override this.
   *
   * @return {<xul:browser>}
   */
  get browser() {
    throw new Error("Not implemented.");
  },

  /**
   * Returns the nsIPrincipal associated with the request.
   *
   * Subclasses must override this.
   *
   * @return {nsIPrincipal}
   */
  get principal() {
    throw new Error("Not implemented.");
  },

  /**
   * Provides the preferred name to use in the permission popups,
   * based on the principal URI (the URI.hostPort for any URI scheme
   * besides the moz-extension one which should default to the
   * extension name).
   */
  get principalName() {
    if (this.principal.addonPolicy) {
      return this.principal.addonPolicy.name;
    }

    return this.principal.URI.hostPort;
  },

  /**
   * If the nsIPermissionManager is being queried and written
   * to for this permission request, set this to the key to be
   * used. If this is undefined, user permissions will not be
   * read from or written to.
   *
   * Note that if a permission is set, in any follow-up
   * prompting within the expiry window of that permission,
   * the prompt will be skipped and the allow or deny choice
   * will be selected automatically.
   */
  get permissionKey() {
    return undefined;
  },

  /**
   * These are the options that will be passed to the
   * PopupNotification when it is shown. See the documentation
   * for PopupNotification for more details.
   *
   * Note that prompt() will automatically set displayURI to
   * be the URI of the requesting pricipal, unless the displayURI is exactly
   * set to false.
   */
  get popupOptions() {
    return {};
  },

  /**
   * PopupNotification requires a unique ID to open the notification.
   * You must return a unique ID string here, for which PopupNotification
   * will then create a <xul:popupnotification> node with the ID
   * "<notificationID>-notification".
   *
   * If there's a custom <xul:popupnotification> you're hoping to show,
   * then you need to make sure its ID has the "-notification" suffix,
   * and then return the prefix here.
   *
   * See PopupNotification.jsm for more details.
   *
   * @return {string}
   *         The unique ID that will be used to as the
   *         "<unique ID>-notification" ID for the <xul:popupnotification>
   *         to use or create.
   */
  get notificationID() {
    throw new Error("Not implemented.");
  },

  /**
   * The ID of the element to anchor the PopupNotification to.
   *
   * @return {string}
   */
  get anchorID() {
    return "default-notification-icon";
  },

  /**
   * The message to show to the user in the PopupNotification. A string
   * with "<>" as a placeholder that is usually replaced by an addon name
   * or a host name, formatted in bold, to describe the permission that is being requested.
   *
   * Subclasses must override this.
   *
   * @return {string}
   */
  get message() {
    throw new Error("Not implemented.");
  },

  /**
   * This will be called if the request is to be cancelled.
   *
   * Subclasses only need to override this if they provide a
   * permissionKey.
   */
  cancel() {
    throw new Error("Not implemented.");
  },

  /**
   * This will be called if the request is to be allowed.
   *
   * Subclasses only need to override this if they provide a
   * permissionKey.
   */
  allow() {
    throw new Error("Not implemented.");
  },

  /**
   * The actions that will be displayed in the PopupNotification
   * via a dropdown menu. The first item in this array will be
   * the default selection. Each action is an Object with the
   * following properties:
   *
   *  label (string):
   *    The label that will be displayed for this choice.
   *  accessKey (string):
   *    The access key character that will be used for this choice.
   *  action (SitePermissions state)
   *    The action that will be associated with this choice.
   *    This should be either SitePermissions.ALLOW or SitePermissions.BLOCK.
   *
   *  callback (function, optional)
   *    A callback function that will fire if the user makes this choice, with
   *    a single parameter, state. State is an Object that contains the property
   *    checkboxChecked, which identifies whether the checkbox to remember this
   *    decision was checked.
   */
  get promptActions() {
    return [];
  },

  /**
   * If the prompt will be shown to the user, this callback will
   * be called just before. Subclasses may want to override this
   * in order to, for example, bump a counter Telemetry probe for
   * how often a particular permission request is seen.
   */
  onBeforeShow() {},

  /**
   * If the prompt was be shown to the user, this callback will
   * be called just after its been hidden.
   */
  onAfterShow() {},

  /**
   * Will determine if a prompt should be shown to the user, and if so,
   * will show it.
   *
   * If a permissionKey is defined prompt() might automatically
   * allow or cancel itself based on the user's current
   * permission settings without displaying the prompt.
   *
   * If the permission is not already set and the <xul:browser> that the request
   * is associated with does not belong to a browser window with the
   * PopupNotifications global set, the prompt request is ignored.
   */
  prompt() {
    // We ignore requests from non-nsIStandardURLs
    let requestingURI = this.principal.URI;
    if (!(requestingURI instanceof Ci.nsIStandardURL)) {
      return;
    }

    if (this.permissionKey) {
      // If we're reading and setting permissions, then we need
      // to check to see if we already have a permission setting
      // for this particular principal.
      let {state} = SitePermissions.get(requestingURI,
                                        this.permissionKey,
                                        this.browser);

      if (state == SitePermissions.BLOCK) {
        // If the request is blocked by a global setting then we record
        // a flag that lasts for the duration of the current page load
        // to notify the user that the permission has been blocked.
        // Currently only applies to autoplay-media
        if (state == SitePermissions.getDefault(this.permissionKey) &&
            SitePermissions.showGloballyBlocked(this.permissionKey)) {
          SitePermissions.set(this.principal.URI,
                              this.permissionKey,
                              state,
                              SitePermissions.SCOPE_GLOBAL,
                              this.browser);
        }

        this.cancel();
        return;
      }

      if (state == SitePermissions.ALLOW) {
        this.allow();
        return;
      }

      // Tell the browser to refresh the identity block display in case there
      // are expired permission states.
      this.browser.dispatchEvent(new this.browser.ownerGlobal
                                         .CustomEvent("PermissionStateChange"));
    }

    let chromeWin = this.browser.ownerGlobal;
    if (!chromeWin.PopupNotifications) {
      this.cancel();
      return;
    }

    // Transform the PermissionPrompt actions into PopupNotification actions.
    let popupNotificationActions = [];
    for (let promptAction of this.promptActions) {
      let action = {
        label: promptAction.label,
        accessKey: promptAction.accessKey,
        callback: state => {
          if (promptAction.callback) {
            promptAction.callback();
          }

          if (this.permissionKey) {
            if ((state && state.checkboxChecked && state.source != "esc-press") ||
                promptAction.scope == SitePermissions.SCOPE_PERSISTENT) {
              // Permanently store permission.
              let scope = SitePermissions.SCOPE_PERSISTENT;
              // Only remember permission for session if in PB mode.
              if (PrivateBrowsingUtils.isBrowserPrivate(this.browser)) {
                scope = SitePermissions.SCOPE_SESSION;
              }
              SitePermissions.set(this.principal.URI,
                                  this.permissionKey,
                                  promptAction.action,
                                  scope);
            } else if (promptAction.action == SitePermissions.BLOCK ||
                       SitePermissions.permitTemporaryAllow(this.permissionKey)) {
              // Temporarily store BLOCK permissions only unless permission object
              // sets permitTemporaryAllow: true
              // SitePermissions does not consider subframes when storing temporary
              // permissions on a tab, thus storing ALLOW could be exploited.
              SitePermissions.set(this.principal.URI,
                                  this.permissionKey,
                                  promptAction.action,
                                  SitePermissions.SCOPE_TEMPORARY,
                                  this.browser);
            }

            // Grant permission if action is ALLOW.
            if (promptAction.action == SitePermissions.ALLOW) {
              this.allow();
            } else {
              this.cancel();
            }
          }
        },
      };
      if (promptAction.dismiss) {
        action.dismiss = promptAction.dismiss;
      }

      popupNotificationActions.push(action);
    }

    let mainAction = popupNotificationActions.length ?
                     popupNotificationActions[0] : null;
    let secondaryActions = popupNotificationActions.splice(1);

    let options = this.popupOptions;

    if (!options.hasOwnProperty("displayURI") || options.displayURI) {
      options.displayURI = this.principal.URI;
    }
    // Permission prompts are always persistent; the close button is controlled by a pref.
    options.persistent = true;
    options.hideClose = !Services.prefs.getBoolPref("privacy.permissionPrompts.showCloseButton");
    options.eventCallback = (topic) => {
      // When the docshell of the browser is aboout to be swapped to another one,
      // the "swapping" event is called. Returning true causes the notification
      // to be moved to the new browser.
      if (topic == "swapping") {
        return true;
      }
      // The prompt has been removed, notify the PermissionUI.
      if (topic == "removed") {
        this.onAfterShow();
      }
      return false;
    };

    this.onBeforeShow();
    chromeWin.PopupNotifications.show(this.browser,
                                      this.notificationID,
                                      this.message,
                                      this.anchorID,
                                      mainAction,
                                      secondaryActions,
                                      options);
  },
};

PermissionUI.PermissionPromptPrototype = PermissionPromptPrototype;

/**
 * A subclass of PermissionPromptPrototype that assumes
 * that this.request is an nsIContentPermissionRequest
 * and fills in some of the required properties on the
 * PermissionPrompt. For callers that are wrapping an
 * nsIContentPermissionRequest, this should be subclassed
 * rather than PermissionPromptPrototype.
 */
var PermissionPromptForRequestPrototype = {
  __proto__: PermissionPromptPrototype,

  get browser() {
    // In the e10s-case, the <xul:browser> will be at request.element.
    // In the single-process case, we have to use some XPCOM incantations
    // to resolve to the <xul:browser>.
    if (this.request.element) {
      return this.request.element;
    }
    return this.request.window.docShell.chromeEventHandler;
  },

  get principal() {
    return this.request.principal;
  },

  cancel() {
    this.request.cancel();
  },

  allow() {
    this.request.allow();
  },
};

PermissionUI.PermissionPromptForRequestPrototype =
  PermissionPromptForRequestPrototype;

/**
 * Creates a PermissionPrompt for a nsIContentPermissionRequest for
 * the GeoLocation API.
 *
 * @param request (nsIContentPermissionRequest)
 *        The request for a permission from content.
 */
function GeolocationPermissionPrompt(request) {
  this.request = request;
}

GeolocationPermissionPrompt.prototype = {
  __proto__: PermissionPromptForRequestPrototype,

  get permissionKey() {
    return "geo";
  },

  get popupOptions() {
    let pref = "browser.geolocation.warning.infoURL";
    let options = {
      learnMoreURL: Services.urlFormatter.formatURLPref(pref),
      displayURI: false,
      name: this.principalName,
    };

    if (this.principal.URI.schemeIs("file")) {
      options.checkbox = { show: false };
    } else {
      // Don't offer "always remember" action in PB mode
      options.checkbox = {
        show: !PrivateBrowsingUtils.isWindowPrivate(this.browser.ownerGlobal)
      };
    }

    if (options.checkbox.show) {
      options.checkbox.label = gBrowserBundle.GetStringFromName("geolocation.remember");
    }

    return options;
  },

  get notificationID() {
    return "geolocation";
  },

  get anchorID() {
    return "geo-notification-icon";
  },

  get message() {
    if (this.principal.URI.schemeIs("file")) {
      return gBrowserBundle.GetStringFromName("geolocation.shareWithFile3");
    }

    return gBrowserBundle.formatStringFromName("geolocation.shareWithSite3",
                                               ["<>"], 1);
  },

  get promptActions() {
    // We collect Telemetry data on Geolocation prompts and how users
    // respond to them. The probe keys are a bit verbose, so let's alias them.
    const SHARE_LOCATION =
      Ci.nsISecurityUITelemetry.WARNING_GEOLOCATION_REQUEST_SHARE_LOCATION;
    const ALWAYS_SHARE =
      Ci.nsISecurityUITelemetry.WARNING_GEOLOCATION_REQUEST_ALWAYS_SHARE;
    const NEVER_SHARE =
      Ci.nsISecurityUITelemetry.WARNING_GEOLOCATION_REQUEST_NEVER_SHARE;

    let secHistogram = Services.telemetry.getHistogramById("SECURITY_UI");

    return [{
      label: gBrowserBundle.GetStringFromName("geolocation.allowLocation"),
      accessKey:
        gBrowserBundle.GetStringFromName("geolocation.allowLocation.accesskey"),
      action: SitePermissions.ALLOW,
      callback(state) {
        if (state && state.checkboxChecked) {
          secHistogram.add(ALWAYS_SHARE);
        } else {
          secHistogram.add(SHARE_LOCATION);
        }
      },
    }, {
      label: gBrowserBundle.GetStringFromName("geolocation.dontAllowLocation"),
      accessKey:
        gBrowserBundle.GetStringFromName("geolocation.dontAllowLocation.accesskey"),
      action: SitePermissions.BLOCK,
      callback(state) {
        if (state && state.checkboxChecked) {
          secHistogram.add(NEVER_SHARE);
        }
      },
    }];
  },

  onBeforeShow() {
    let secHistogram = Services.telemetry.getHistogramById("SECURITY_UI");
    const SHOW_REQUEST = Ci.nsISecurityUITelemetry.WARNING_GEOLOCATION_REQUEST;
    secHistogram.add(SHOW_REQUEST);
  },
};

PermissionUI.GeolocationPermissionPrompt = GeolocationPermissionPrompt;

/**
 * Creates a PermissionPrompt for a nsIContentPermissionRequest for
 * the Desktop Notification API.
 *
 * @param request (nsIContentPermissionRequest)
 *        The request for a permission from content.
 * @return {PermissionPrompt} (see documentation in header)
 */
function DesktopNotificationPermissionPrompt(request) {
  this.request = request;
}

DesktopNotificationPermissionPrompt.prototype = {
  __proto__: PermissionPromptForRequestPrototype,

  get permissionKey() {
    return "desktop-notification";
  },

  get popupOptions() {
    let learnMoreURL =
      Services.urlFormatter.formatURLPref("app.support.baseURL") + "push";

    return {
      learnMoreURL,
      displayURI: false,
      name: this.principalName,
    };
  },

  get notificationID() {
    return "web-notifications";
  },

  get anchorID() {
    return "web-notifications-notification-icon";
  },

  get message() {
    return gBrowserBundle.formatStringFromName("webNotifications.receiveFromSite2",
                                                    ["<>"], 1);
  },

  get promptActions() {
    let actions = [
      {
        label: gBrowserBundle.GetStringFromName("webNotifications.allow"),
        accessKey:
          gBrowserBundle.GetStringFromName("webNotifications.allow.accesskey"),
        action: SitePermissions.ALLOW,
        scope: SitePermissions.SCOPE_PERSISTENT,
      },
      {
        label: gBrowserBundle.GetStringFromName("webNotifications.notNow"),
        accessKey:
          gBrowserBundle.GetStringFromName("webNotifications.notNow.accesskey"),
        action: SitePermissions.BLOCK,
      },
    ];
    if (!PrivateBrowsingUtils.isBrowserPrivate(this.browser)) {
      actions.push({
        label: gBrowserBundle.GetStringFromName("webNotifications.never"),
        accessKey:
          gBrowserBundle.GetStringFromName("webNotifications.never.accesskey"),
        action: SitePermissions.BLOCK,
        scope: SitePermissions.SCOPE_PERSISTENT,
      });
    }
    return actions;
  },
};

PermissionUI.DesktopNotificationPermissionPrompt =
  DesktopNotificationPermissionPrompt;

/**
 * Creates a PermissionPrompt for a nsIContentPermissionRequest for
 * the persistent-storage API.
 *
 * @param request (nsIContentPermissionRequest)
 *        The request for a permission from content.
 */
function PersistentStoragePermissionPrompt(request) {
  this.request = request;
}

PersistentStoragePermissionPrompt.prototype = {
  __proto__: PermissionPromptForRequestPrototype,

  get permissionKey() {
    return "persistent-storage";
  },

  get popupOptions() {
    let checkbox = {
      // In PB mode, we don't want the "always remember" checkbox
      show: !PrivateBrowsingUtils.isWindowPrivate(this.browser.ownerGlobal)
    };
    if (checkbox.show) {
      checkbox.checked = true;
      checkbox.label = gBrowserBundle.GetStringFromName("persistentStorage.remember");
    }
    let learnMoreURL =
      Services.urlFormatter.formatURLPref("app.support.baseURL") + "storage-permissions";
    return {
      checkbox,
      learnMoreURL,
      displayURI: false,
      name: this.principalName,
    };
  },

  get notificationID() {
    return "persistent-storage";
  },

  get anchorID() {
    return "persistent-storage-notification-icon";
  },

  get message() {
    return gBrowserBundle.formatStringFromName("persistentStorage.allowWithSite",
                                                    ["<>"], 1);
  },

  get promptActions() {
    return [
      {
        label: gBrowserBundle.GetStringFromName("persistentStorage.allow"),
        accessKey:
          gBrowserBundle.GetStringFromName("persistentStorage.allow.accesskey"),
        action: Ci.nsIPermissionManager.ALLOW_ACTION
      },
      {
        label: gBrowserBundle.GetStringFromName("persistentStorage.dontAllow"),
        accessKey:
          gBrowserBundle.GetStringFromName("persistentStorage.dontAllow.accesskey"),
        action: Ci.nsIPermissionManager.DENY_ACTION
      }
    ];
  }
};

PermissionUI.PersistentStoragePermissionPrompt = PersistentStoragePermissionPrompt;

/**
 * Creates a PermissionPrompt for a nsIContentPermissionRequest for
 * the WebMIDI API.
 *
 * @param request (nsIContentPermissionRequest)
 *        The request for a permission from content.
 */
function MIDIPermissionPrompt(request) {
  this.request = request;
  let types = request.types.QueryInterface(Ci.nsIArray);
  let perm = types.queryElementAt(0, Ci.nsIContentPermissionType);
  this.isSysexPerm = (perm.options.length > 0 &&
                      perm.options.queryElementAt(0, Ci.nsISupportsString) == "sysex");
  this.permName = "midi";
  if (this.isSysexPerm) {
    this.permName = "midi-sysex";
  }
}

MIDIPermissionPrompt.prototype = {
  __proto__: PermissionPromptForRequestPrototype,

  get permissionKey() {
    return this.permName;
  },

  get popupOptions() {
    // TODO (bug 1433235) We need a security/permissions explanation URL for this
    let options = {
      displayURI: false,
      name: this.principalName,
    };

    if (this.principal.URI.schemeIs("file")) {
      options.checkbox = { show: false };
    } else {
      // Don't offer "always remember" action in PB mode
      options.checkbox = {
        show: !PrivateBrowsingUtils.isWindowPrivate(this.browser.ownerGlobal)
      };
    }

    if (options.checkbox.show) {
      options.checkbox.label = gBrowserBundle.GetStringFromName("midi.remember");
    }

    return options;
  },

  get notificationID() {
    return "midi";
  },

  get anchorID() {
    return "midi-notification-icon";
  },

  get message() {
    let message;
    if (this.principal.URI.schemeIs("file")) {
      if (this.isSysexPerm) {
        message = gBrowserBundle.formatStringFromName("midi.shareSysexWithFile.message");
      } else {
        message = gBrowserBundle.formatStringFromName("midi.shareWithFile.message");
      }
    } else if (this.isSysexPerm) {
      message = gBrowserBundle.formatStringFromName("midi.shareSysexWithSite.message",
                                                    ["<>"], 1);
    } else {
      message = gBrowserBundle.formatStringFromName("midi.shareWithSite.message",
                                                    ["<>"], 1);
    }
    return message;
  },

  get promptActions() {
    return [{
        label: gBrowserBundle.GetStringFromName("midi.Allow.label"),
        accessKey: gBrowserBundle.GetStringFromName("midi.Allow.accesskey"),
        action: Ci.nsIPermissionManager.ALLOW_ACTION
      },
      {
        label: gBrowserBundle.GetStringFromName("midi.DontAllow.label"),
        accessKey: gBrowserBundle.GetStringFromName("midi.DontAllow.accesskey"),
        action: Ci.nsIPermissionManager.DENY_ACTION
    }];
  },

  onBeforeShow() {
  },
};

PermissionUI.MIDIPermissionPrompt = MIDIPermissionPrompt;

function AutoplayPermissionPrompt(request) {
  this.request = request;
}

AutoplayPermissionPrompt.prototype = {
  __proto__: PermissionPromptForRequestPrototype,

  get permissionKey() {
    return "autoplay-media";
  },

  get popupOptions() {
    let learnMoreURL =
      Services.urlFormatter.formatURLPref("app.support.baseURL") + "block-autoplay";
    let checkbox = {show: !this.principal.URI.schemeIs("file")};
    if (checkbox.show) {
      checkbox.checked = true;
      checkbox.label = PrivateBrowsingUtils.isWindowPrivate(this.browser.ownerGlobal) ?
        gBrowserBundle.GetStringFromName("autoplay.remember-private") :
        gBrowserBundle.GetStringFromName("autoplay.remember");
    }
    return {
      checkbox,
      learnMoreURL,
      displayURI: false,
      name: this.principal.URI.hostPort,
    };
  },

  get notificationID() {
    return "autoplay-media";
  },

  get anchorID() {
    return "autoplay-media-notification-icon";
  },

  get message() {
    if (this.principal.URI.schemeIs("file")) {
      return gBrowserBundle.GetStringFromName("autoplay.messageWithFile");
    }
    return gBrowserBundle.formatStringFromName("autoplay.message", ["<>"], 1);
  },

  get promptActions() {
    return [{
        label: gBrowserBundle.GetStringFromName("autoplay.Allow2.label"),
        accessKey: gBrowserBundle.GetStringFromName("autoplay.Allow2.accesskey"),
        action: Ci.nsIPermissionManager.ALLOW_ACTION,
      },
      {
        label: gBrowserBundle.GetStringFromName("autoplay.DontAllow.label"),
        accessKey: gBrowserBundle.GetStringFromName("autoplay.DontAllow.accesskey"),
        action: Ci.nsIPermissionManager.DENY_ACTION,
    }];
  },

  onAfterShow() {
    // Remove the event listener to prevent any leaks.
    this.browser.removeEventListener(
      "DOMAudioPlaybackStarted", this.handlePlaybackStart);
  },

  onBeforeShow() {
    // Hide the prompt if the tab starts playing media.
    this.handlePlaybackStart = () => {
      let chromeWin = this.browser.ownerGlobal;
      if (!chromeWin.PopupNotifications) {
        return;
      }
      let notification = chromeWin.PopupNotifications.getNotification(
        this.notificationID, this.browser);
      if (notification) {
        chromeWin.PopupNotifications.remove(notification);
      }
    };
    this.browser.addEventListener(
      "DOMAudioPlaybackStarted", this.handlePlaybackStart);
  },
};

PermissionUI.AutoplayPermissionPrompt = AutoplayPermissionPrompt;
