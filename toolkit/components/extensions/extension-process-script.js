/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

/**
 * This script contains the minimum, skeleton content process code that we need
 * in order to lazily load other extension modules when they are first
 * necessary. Anything which is not likely to be needed immediately, or shortly
 * after startup, in *every* browser process live outside of this file.
 */

ChromeUtils.import("resource://gre/modules/MessageChannel.jsm");
ChromeUtils.import("resource://gre/modules/Services.jsm");
ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyModuleGetters(this, {
  ExtensionChild: "resource://gre/modules/ExtensionChild.jsm",
  ExtensionCommon: "resource://gre/modules/ExtensionCommon.jsm",
  ExtensionContent: "resource://gre/modules/ExtensionContent.jsm",
  ExtensionPageChild: "resource://gre/modules/ExtensionPageChild.jsm",
});

ChromeUtils.import("resource://gre/modules/ExtensionUtils.jsm");

XPCOMUtils.defineLazyGetter(this, "console", () => ExtensionCommon.getConsole());

const {
  DefaultWeakMap,
  getInnerWindowID,
} = ExtensionUtils;

const {sharedData} = Services.cpmm;

function getData(extension, key = "") {
  return sharedData.get(`extension/${extension.id}/${key}`);
}

// We need to avoid touching Services.appinfo here in order to prevent
// the wrong version from being cached during xpcshell test startup.
// eslint-disable-next-line mozilla/use-services
const appinfo = Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULRuntime);
const isContentProcess = appinfo.processType == appinfo.PROCESS_TYPE_CONTENT;

var extensions = new DefaultWeakMap(policy => {
  return new ExtensionChild.BrowserExtensionContent(policy);
});

var ExtensionManager;

class ExtensionGlobal {
  constructor(global) {
    this.global = global;
    this.global.addMessageListener("Extension:SetFrameData", this);

    this.frameData = null;

    MessageChannel.addListener(global, "Extension:Capture", this);
    MessageChannel.addListener(global, "Extension:DetectLanguage", this);
    MessageChannel.addListener(global, "Extension:Execute", this);
    MessageChannel.addListener(global, "WebNavigation:GetFrame", this);
    MessageChannel.addListener(global, "WebNavigation:GetAllFrames", this);
  }

  get messageFilterStrict() {
    return {
      innerWindowID: getInnerWindowID(this.global.content),
    };
  }

  getFrameData(force = false) {
    if (!this.frameData && force) {
      this.frameData = this.global.sendSyncMessage("Extension:GetTabAndWindowId")[0];
    }
    return this.frameData;
  }

  receiveMessage({target, messageName, recipient, data, name}) {
    switch (name) {
      case "Extension:SetFrameData":
        if (this.frameData) {
          Object.assign(this.frameData, data);
        } else {
          this.frameData = data;
        }
        if (data.viewType && WebExtensionPolicy.isExtensionProcess) {
          ExtensionPageChild.expectViewLoad(this.global, data.viewType);
        }
        return;
    }

    return ExtensionContent.receiveMessage(this.global, messageName, target, data, recipient);
  }
}

ExtensionManager = {
  // WeakMap<WebExtensionPolicy, Map<string, WebExtensionContentScript>>
  registeredContentScripts: new DefaultWeakMap((policy) => new Map()),

  globals: new WeakMap(),

  init() {
    MessageChannel.setupMessageManagers([Services.cpmm]);

    Services.cpmm.addMessageListener("Extension:Startup", this);
    Services.cpmm.addMessageListener("Extension:Shutdown", this);
    Services.cpmm.addMessageListener("Extension:FlushJarCache", this);
    Services.cpmm.addMessageListener("Extension:RegisterContentScript", this);
    Services.cpmm.addMessageListener("Extension:UnregisterContentScripts", this);

    // eslint-disable-next-line mozilla/balanced-listeners
    Services.obs.addObserver(
      global => this.globals.set(global, new ExtensionGlobal(global)),
      "tab-content-frameloader-created");

    for (let id of sharedData.get("extensions/activeIDs") || []) {
      this.initExtension(getData({id}));
    }
  },

  initExtensionPolicy(extension) {
    let policy = WebExtensionPolicy.getByID(extension.id);
    if (!policy) {
      let localizeCallback;
      if (extension.localize) {
        // We have a real Extension object.
        localizeCallback = extension.localize.bind(extension);
      } else {
        // We have serialized extension data;
        localizeCallback = str => extensions.get(policy).localize(str);
      }

      let {backgroundScripts} = extension;
      if (!backgroundScripts && WebExtensionPolicy.isExtensionProcess) {
        ({backgroundScripts} = getData(extension, "extendedData") || {});
      }

      policy = new WebExtensionPolicy({
        id: extension.id,
        mozExtensionHostname: extension.uuid,
        name: extension.name,
        baseURL: extension.resourceURL,

        permissions: extension.permissions,
        allowedOrigins: extension.whiteListedHosts,
        webAccessibleResources: extension.webAccessibleResources,

        contentSecurityPolicy: extension.contentSecurityPolicy,

        localizeCallback,

        backgroundScripts,

        contentScripts: extension.contentScripts,
      });

      policy.debugName = `${JSON.stringify(policy.name)} (ID: ${policy.id}, ${policy.getURL()})`;

      // Register any existent dynamically registered content script for the extension
      // when a content process is started for the first time (which also cover
      // a content process that crashed and it has been recreated).
      const registeredContentScripts = this.registeredContentScripts.get(policy);

      for (let [scriptId, options] of getData(extension, "contentScripts") || []) {
        const script = new WebExtensionContentScript(policy, options);
        policy.registerContentScript(script);
        registeredContentScripts.set(scriptId, script);
      }

      policy.active = true;
      policy.instanceId = extension.instanceId;
      policy.optionalPermissions = extension.optionalPermissions;
    }
    return policy;
  },

  initExtension(data) {
    if (typeof data === "string") {
      data = getData({id: data});
    }
    let policy = this.initExtensionPolicy(data);

    policy.injectContentScripts();
  },

  receiveMessage({name, data}) {
    try {
      switch (name) {
        case "Extension:Startup":
          this.initExtension(data);
          break;

        case "Extension:Shutdown": {
          let policy = WebExtensionPolicy.getByID(data.id);
          if (policy) {
            if (extensions.has(policy)) {
              extensions.get(policy).shutdown();
            }

            if (isContentProcess) {
              policy.active = false;
            }
          }
          break;
        }

        case "Extension:FlushJarCache":
          ExtensionUtils.flushJarCache(data.path);
          break;

        case "Extension:RegisterContentScript": {
          let policy = WebExtensionPolicy.getByID(data.id);

          if (policy) {
            const registeredContentScripts = this.registeredContentScripts.get(policy);

            if (registeredContentScripts.has(data.scriptId)) {
              Cu.reportError(new Error(
                `Registering content script ${data.scriptId} on ${data.id} more than once`));
            } else {
              const script = new WebExtensionContentScript(policy, data.options);
              policy.registerContentScript(script);
              registeredContentScripts.set(data.scriptId, script);
            }
          }
          break;
        }

        case "Extension:UnregisterContentScripts": {
          let policy = WebExtensionPolicy.getByID(data.id);

          if (policy) {
            const registeredContentScripts = this.registeredContentScripts.get(policy);

            for (const scriptId of data.scriptIds) {
              const script = registeredContentScripts.get(scriptId);
              if (script) {
                policy.unregisterContentScript(script);
                registeredContentScripts.delete(scriptId);
              }
            }
          }
          break;
        }
      }
    } catch (e) {
      Cu.reportError(e);
    }
    Services.cpmm.sendAsyncMessage(`${name}Complete`);
  },
};

function ExtensionProcessScript() {
}

ExtensionProcessScript.prototype = {
  classID: Components.ID("{21f9819e-4cdf-49f9-85a0-850af91a5058}"),
  QueryInterface: ChromeUtils.generateQI([Ci.mozIExtensionProcessScript]),

  _xpcom_factory: XPCOMUtils.generateSingletonFactory(ExtensionProcessScript),

  get wrappedJSObject() { return this; },

  extensions,

  getFrameData(global, force) {
    let extGlobal = ExtensionManager.globals.get(global);
    return extGlobal && extGlobal.getFrameData(force);
  },

  initExtension(extension) {
    return ExtensionManager.initExtensionPolicy(extension);
  },

  initExtensionDocument(policy, doc, privileged) {
    let extension = extensions.get(policy);
    if (privileged) {
      ExtensionPageChild.initExtensionContext(extension, doc.defaultView);
    } else {
      ExtensionContent.initExtensionContext(extension, doc.defaultView);
    }
  },

  getExtensionChild(id) {
    let policy = WebExtensionPolicy.getByID(id);
    if (policy) {
      return extensions.get(policy);
    }
  },

  preloadContentScript(contentScript) {
    ExtensionContent.contentScripts.get(contentScript).preload();
  },

  loadContentScript(contentScript, window) {
    return ExtensionContent.contentScripts.get(contentScript).injectInto(window);
  },
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([ExtensionProcessScript]);

ExtensionManager.init();
