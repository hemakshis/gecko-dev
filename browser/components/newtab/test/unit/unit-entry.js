import {EventEmitter, FakePerformance, FakePrefs, GlobalOverrider} from "test/unit/utils";
import Adapter from "enzyme-adapter-react-16";
import {chaiAssertions} from "test/schemas/pings";
import chaiJsonSchema from "chai-json-schema";
import enzyme from "enzyme";
enzyme.configure({adapter: new Adapter()});

class DownloadElementShell {
  downloadsCmd_open() {}
  downloadsCmd_show() {}
  downloadsCmd_openReferrer() {}
  downloadsCmd_delete() {}
  get sizeStrings() { return {stateLabel: "1.5 MB"}; }
  displayName() {}
}

// Cause React warnings to make tests that trigger them fail
const origConsoleError = console.error; // eslint-disable-line no-console
console.error = function(msg, ...args) { // eslint-disable-line no-console
  // eslint-disable-next-line no-console
  origConsoleError.apply(console, [msg, ...args]);

  if (/(Invalid prop|Failed prop type|Check the render method|React Intl)/.test(msg)) {
    throw new Error(msg);
  }
};

const req = require.context(".", true, /\.test\.jsx?$/);
const files = req.keys();

// This exposes sinon assertions to chai.assert
sinon.assert.expose(assert, {prefix: ""});

chai.use(chaiAssertions);
chai.use(chaiJsonSchema);

const overrider = new GlobalOverrider();
const TEST_GLOBAL = {
  AddonManager: {
    getActiveAddons() {
      return Promise.resolve({addons: [], fullData: false});
    }
  },
  AppConstants: {MOZILLA_OFFICIAL: true},
  ChromeUtils: {
    defineModuleGetter() {},
    generateQI() { return {}; },
    import(str) {
      if (str === "resource://services-settings/remote-settings.js") {
        return {RemoteSettings: TEST_GLOBAL.RemoteSettings};
      }
      return {};
    }
  },
  Components: {isSuccessCode: () => true},
  // eslint-disable-next-line object-shorthand
  ContentSearchUIController: function() {}, // NB: This is a function/constructor
  Cc: {
    "@mozilla.org/browser/nav-bookmarks-service;1": {
      addObserver() {},
      getService() {
        return this;
      },
      removeObserver() {},
      SOURCES: {},
      TYPE_BOOKMARK: {}
    },
    "@mozilla.org/browser/nav-history-service;1": {
      addObserver() {},
      executeQuery() {},
      getNewQuery() {},
      getNewQueryOptions() {},
      getService() {
        return this;
      },
      insert() {},
      markPageAsTyped() {},
      removeObserver() {}
    }
  },
  Ci: {
    nsIHttpChannel: {REFERRER_POLICY_UNSAFE_URL: 5},
    nsITimer: {TYPE_ONE_SHOT: 1}
  },
  Cu: {
    importGlobalProperties() {},
    now: () => window.performance.now(),
    reportError() {}
  },
  dump() {},
  fetch() {},
  // eslint-disable-next-line object-shorthand
  Image: function() {}, // NB: This is a function/constructor
  NewTabUtils: {activityStreamProvider: {getTopFrecentSites: () => []}},
  PlacesUtils: {
    get bookmarks() {
      return TEST_GLOBAL.Cc["@mozilla.org/browser/nav-bookmarks-service;1"];
    },
    get history() {
      return TEST_GLOBAL.Cc["@mozilla.org/browser/nav-history-service;1"];
    }
  },
  PluralForm: {get() {}},
  Preferences: FakePrefs,
  PrivateBrowsingUtils: {isWindowPrivate: () => false},
  DownloadsViewUI: {DownloadElementShell},
  Services: {
    locale: {
      getAppLocaleAsLangTag() { return "en-US"; },
      getAppLocalesAsLangTags() {},
      negotiateLanguages() {}
    },
    urlFormatter: {formatURL: str => str},
    mm: {
      addMessageListener: (msg, cb) => cb(),
      removeMessageListener() {}
    },
    appShell: {hiddenDOMWindow: {performance: new FakePerformance()}},
    obs: {
      addObserver() {},
      removeObserver() {}
    },
    telemetry: {
      setEventRecordingEnabled: () => {},
      recordEvent: eventDetails => {}
    },
    console: {logStringMessage: () => {}},
    prefs: {
      addObserver() {},
      prefHasUserValue() {},
      removeObserver() {},
      getPrefType() {},
      clearUserPref() {},
      getStringPref() {},
      getIntPref() {},
      getBoolPref() {},
      setBoolPref() {},
      setIntPref() {},
      getBranch() {},
      PREF_BOOL: "boolean",
      PREF_INT: "integer",
      PREF_STRING: "string",
      getDefaultBranch() {
        return {
          setBoolPref() {},
          setIntPref() {},
          setStringPref() {},
          clearUserPref() {}
        };
      }
    },
    tm: {
      dispatchToMainThread: cb => cb(),
      idleDispatchToMainThread: cb => cb()
    },
    eTLD: {
      getBaseDomain({spec}) { return spec.match(/\/([^/]+)/)[1]; },
      getPublicSuffix() {}
    },
    io: {
      newURI: spec => ({
        mutate: () => ({
          setRef: ref => ({
            finalize: () => ({
              ref,
              spec
            })
          })
        }),
        spec
      })
    },
    search: {
      init(cb) { cb(); },
      getVisibleEngines: () => [{identifier: "google"}, {identifier: "bing"}],
      defaultEngine: {identifier: "google"},
      currentEngine: {identifier: "google", searchForm: "https://www.google.com/search?q=&ie=utf-8&oe=utf-8&client=firefox-b"}
    },
    scriptSecurityManager: {
      createNullPrincipal() {},
      getSystemPrincipal() {}
    },
    wm: {getMostRecentWindow: () => window, getEnumerator: () => ({hasMoreElements: () => false})},
    ww: {registerNotification() {}, unregisterNotification() {}},
    appinfo: {appBuildID: "20180710100040"}
  },
  XPCOMUtils: {
    defineLazyGetter(object, name, f) {
      if (object && name) {
        object[name] = f();
      } else {
        f();
      }
    },
    defineLazyGlobalGetters() {},
    defineLazyModuleGetter() {},
    defineLazyServiceGetter() {},
    generateQI() { return {}; }
  },
  EventEmitter,
  ShellService: {isDefaultBrowser: () => true},
  FilterExpressions: {eval() { return Promise.resolve(true); }},
  RemoteSettings() { return {get() { return Promise.resolve([]); }}; }
};
overrider.set(TEST_GLOBAL);

describe("activity-stream", () => {
  after(() => overrider.restore());
  files.forEach(file => req(file));
});
