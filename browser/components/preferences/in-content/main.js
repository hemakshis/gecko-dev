/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from extensionControlled.js */
/* import-globals-from preferences.js */
/* import-globals-from ../../../../toolkit/mozapps/preferences/fontbuilder.js */
/* import-globals-from ../../../base/content/aboutDialog-appUpdater.js */

ChromeUtils.import("resource://gre/modules/Services.jsm");
ChromeUtils.import("resource://gre/modules/Downloads.jsm");
ChromeUtils.import("resource://gre/modules/FileUtils.jsm");
ChromeUtils.import("resource:///modules/ShellService.jsm");
ChromeUtils.import("resource:///modules/TransientPrefs.jsm");
ChromeUtils.import("resource://gre/modules/AppConstants.jsm");
ChromeUtils.import("resource://gre/modules/DownloadUtils.jsm");
ChromeUtils.import("resource://gre/modules/L10nRegistry.jsm");
ChromeUtils.import("resource://gre/modules/Localization.jsm");
ChromeUtils.defineModuleGetter(this, "CloudStorage",
  "resource://gre/modules/CloudStorage.jsm");

XPCOMUtils.defineLazyServiceGetters(this, {
  gCategoryManager: ["@mozilla.org/categorymanager;1", "nsICategoryManager"],
  gHandlerService: ["@mozilla.org/uriloader/handler-service;1", "nsIHandlerService"],
  gMIMEService: ["@mozilla.org/mime;1", "nsIMIMEService"],
});

// Constants & Enumeration Values
const TYPE_MAYBE_FEED = "application/vnd.mozilla.maybe.feed";
const TYPE_MAYBE_VIDEO_FEED = "application/vnd.mozilla.maybe.video.feed";
const TYPE_MAYBE_AUDIO_FEED = "application/vnd.mozilla.maybe.audio.feed";
const TYPE_PDF = "application/pdf";

const PREF_PDFJS_DISABLED = "pdfjs.disabled";
const TOPIC_PDFJS_HANDLER_CHANGED = "pdfjs:handlerChanged";

const PREF_DISABLED_PLUGIN_TYPES = "plugin.disable_full_page_plugin_for_types";

// Pref for when containers is being controlled
const PREF_CONTAINERS_EXTENSION = "privacy.userContext.extension";

// Preferences that affect which entries to show in the list.
const PREF_SHOW_PLUGINS_IN_LIST = "browser.download.show_plugins_in_list";
const PREF_HIDE_PLUGINS_WITHOUT_EXTENSIONS =
  "browser.download.hide_plugins_without_extensions";

// Strings to identify ExtensionSettingsStore overrides
const CONTAINERS_KEY = "privacy.containers";

/*
 * Preferences where we store handling information about the feed type.
 *
 * browser.feeds.handler
 * - "bookmarks", "reader" (clarified further using the .default preference),
 *   or "ask" -- indicates the default handler being used to process feeds;
 *   "bookmarks" is obsolete; to specify that the handler is bookmarks,
 *   set browser.feeds.handler.default to "bookmarks";
 *
 * browser.feeds.handler.default
 * - "bookmarks" or "client" -- indicates the chosen feed reader used
 *   to display feeds, either transiently (i.e., when the "use as default"
 *   checkbox is unchecked, corresponds to when browser.feeds.handler=="ask")
 *   or more permanently (i.e., the item displayed in the dropdown in Feeds
 *   preferences)
 *
 * browser.feeds.handlers.application
 * - nsIFile, stores the current client-side feed reading app if one has
 *   been chosen
 */
const PREF_FEED_SELECTED_APP = "browser.feeds.handlers.application";
const PREF_FEED_SELECTED_ACTION = "browser.feeds.handler";
const PREF_FEED_SELECTED_READER = "browser.feeds.handler.default";

const PREF_VIDEO_FEED_SELECTED_APP = "browser.videoFeeds.handlers.application";
const PREF_VIDEO_FEED_SELECTED_ACTION = "browser.videoFeeds.handler";
const PREF_VIDEO_FEED_SELECTED_READER = "browser.videoFeeds.handler.default";

const PREF_AUDIO_FEED_SELECTED_APP = "browser.audioFeeds.handlers.application";
const PREF_AUDIO_FEED_SELECTED_ACTION = "browser.audioFeeds.handler";
const PREF_AUDIO_FEED_SELECTED_READER = "browser.audioFeeds.handler.default";

// The nsHandlerInfoAction enumeration values in nsIHandlerInfo identify
// the actions the application can take with content of various types.
// But since nsIHandlerInfo doesn't support plugins, there's no value
// identifying the "use plugin" action, so we use this constant instead.
const kActionUsePlugin = 5;

const ICON_URL_APP = AppConstants.platform == "linux" ?
  "moz-icon://dummy.exe?size=16" :
  "chrome://browser/skin/preferences/application.png";

// For CSS. Can be one of "ask", "save", "plugin" or "feed". If absent, the icon URL
// was set by us to a custom handler icon and CSS should not try to override it.
const APP_ICON_ATTR_NAME = "appHandlerIcon";

ChromeUtils.defineModuleGetter(this, "OS",
  "resource://gre/modules/osfile.jsm");

if (AppConstants.MOZ_DEV_EDITION) {
  ChromeUtils.defineModuleGetter(this, "fxAccounts",
    "resource://gre/modules/FxAccounts.jsm");
  ChromeUtils.defineModuleGetter(this, "FxAccounts",
    "resource://gre/modules/FxAccounts.jsm");
}

Preferences.addAll([
  // Startup
  { id: "browser.startup.page", type: "int" },
  { id: "browser.privatebrowsing.autostart", type: "bool" },

  // Downloads
  { id: "browser.download.useDownloadDir", type: "bool" },
  { id: "browser.download.folderList", type: "int" },
  { id: "browser.download.dir", type: "file" },

  /* Tab preferences
  Preferences:

  browser.link.open_newwindow
      1 opens such links in the most recent window or tab,
      2 opens such links in a new window,
      3 opens such links in a new tab
  browser.tabs.loadInBackground
  - true if display should switch to a new tab which has been opened from a
    link, false if display shouldn't switch
  browser.tabs.warnOnClose
  - true if when closing a window with multiple tabs the user is warned and
    allowed to cancel the action, false to just close the window
  browser.tabs.warnOnOpen
  - true if the user should be warned if he attempts to open a lot of tabs at
    once (e.g. a large folder of bookmarks), false otherwise
  browser.taskbar.previews.enable
  - true if tabs are to be shown in the Windows 7 taskbar
  */

  { id: "browser.link.open_newwindow", type: "int" },
  { id: "browser.tabs.loadInBackground", type: "bool", inverted: true },
  { id: "browser.tabs.warnOnClose", type: "bool" },
  { id: "browser.tabs.warnOnOpen", type: "bool" },
  { id: "browser.sessionstore.restore_on_demand", type: "bool" },
  { id: "browser.ctrlTab.recentlyUsedOrder", type: "bool" },

  // Fonts
  { id: "font.language.group", type: "wstring" },

  // Languages
  { id: "browser.translation.detectLanguage", type: "bool" },

  // General tab

  /* Accessibility
   * accessibility.browsewithcaret
     - true enables keyboard navigation and selection within web pages using a
       visible caret, false uses normal keyboard navigation with no caret
   * accessibility.typeaheadfind
     - when set to true, typing outside text areas and input boxes will
       automatically start searching for what's typed within the current
       document; when set to false, no search action happens */
  { id: "accessibility.browsewithcaret", type: "bool" },
  { id: "accessibility.typeaheadfind", type: "bool" },
  { id: "accessibility.blockautorefresh", type: "bool" },

  /* Browsing
   * general.autoScroll
     - when set to true, clicking the scroll wheel on the mouse activates a
       mouse mode where moving the mouse down scrolls the document downward with
       speed correlated with the distance of the cursor from the original
       position at which the click occurred (and likewise with movement upward);
       if false, this behavior is disabled
   * general.smoothScroll
     - set to true to enable finer page scrolling than line-by-line on page-up,
       page-down, and other such page movements */
  { id: "general.autoScroll", type: "bool" },
  { id: "general.smoothScroll", type: "bool" },
  { id: "layout.spellcheckDefault", type: "int" },

  { id: "browser.preferences.defaultPerformanceSettings.enabled", type: "bool" },
  { id: "dom.ipc.processCount", type: "int" },
  { id: "dom.ipc.processCount.web", type: "int" },
  { id: "layers.acceleration.disabled", type: "bool", inverted: true },

  // Files and Applications
  { id: "browser.feeds.handler", type: "string" },
  { id: "browser.feeds.handler.default", type: "string" },
  { id: "browser.feeds.handlers.application", type: "file" },

  { id: "browser.videoFeeds.handler", type: "string" },
  { id: "browser.videoFeeds.handler.default", type: "string" },
  { id: "browser.videoFeeds.handlers.application", type: "file" },

  { id: "browser.audioFeeds.handler", type: "string" },
  { id: "browser.audioFeeds.handler.default", type: "string" },
  { id: "browser.audioFeeds.handlers.application", type: "file" },

  { id: "pref.downloads.disable_button.edit_actions", type: "bool" },

  // DRM content
  { id: "media.eme.enabled", type: "bool" },

  // Update
  { id: "browser.preferences.advanced.selectedTabIndex", type: "int" },
  { id: "browser.search.update", type: "bool" },

  { id: "privacy.userContext.enabled", type: "bool" },
]);

if (AppConstants.HAVE_SHELL_SERVICE) {
  Preferences.addAll([
    { id: "browser.shell.checkDefaultBrowser", type: "bool" },
    { id: "pref.general.disable_button.default_browser", type: "bool" },
  ]);
}

if (AppConstants.platform === "win") {
  Preferences.addAll([
    { id: "browser.taskbar.previews.enable", type: "bool" },
    { id: "ui.osk.enabled", type: "bool" },
  ]);
}

if (AppConstants.MOZ_UPDATER) {
  Preferences.addAll([
    { id: "app.update.auto", type: "bool" },
    { id: "app.update.disable_button.showUpdateHistory", type: "bool" },
  ]);

  if (AppConstants.MOZ_MAINTENANCE_SERVICE) {
    Preferences.addAll([
      { id: "app.update.service.enabled", type: "bool" },
    ]);
  }
}

// A promise that resolves when the list of application handlers is loaded.
// We store this in a global so tests can await it.
var promiseLoadHandlersList;

// Load the preferences string bundle for a given locale with fallbacks.
function getBundleForLocale(locale) {
  let locales = Array.from(new Set([
    locale,
    ...Services.locale.getRequestedLocales(),
    Services.locale.lastFallbackLocale,
  ]));
  function generateContexts(resourceIds) {
    return L10nRegistry.generateContexts(locales, resourceIds);
  }
  return new Localization([
    "browser/preferences/preferences.ftl",
    "branding/brand.ftl",
  ], generateContexts);
}

var gNodeToObjectMap = new WeakMap();

var gMainPane = {
  // The set of types the app knows how to handle.  A hash of HandlerInfoWrapper
  // objects, indexed by type.
  _handledTypes: {},

  // The list of types we can show, sorted by the sort column/direction.
  // An array of HandlerInfoWrapper objects.  We build this list when we first
  // load the data and then rebuild it when users change a pref that affects
  // what types we can show or change the sort column/direction.
  // Note: this isn't necessarily the list of types we *will* show; if the user
  // provides a filter string, we'll only show the subset of types in this list
  // that match that string.
  _visibleTypes: [],

  // browser.startup.page values
  STARTUP_PREF_BLANK: 0,
  STARTUP_PREF_HOMEPAGE: 1,
  STARTUP_PREF_RESTORE_SESSION: 3,

  // Convenience & Performance Shortcuts

  get _brandShortName() {
    delete this._brandShortName;
    return this._brandShortName = document.getElementById("bundleBrand").getString("brandShortName");
  },

  get _prefsBundle() {
    delete this._prefsBundle;
    return this._prefsBundle = document.getElementById("bundlePreferences");
  },

  get _list() {
    delete this._list;
    return this._list = document.getElementById("handlersView");
  },

  get _filter() {
    delete this._filter;
    return this._filter = document.getElementById("filter");
  },

  _backoffIndex: 0,

  /**
   * Initialization of this.
   */
  init() {
    function setEventListener(aId, aEventType, aCallback) {
      document.getElementById(aId)
        .addEventListener(aEventType, aCallback.bind(gMainPane));
    }

    if (AppConstants.HAVE_SHELL_SERVICE) {
      this.updateSetDefaultBrowser();
      let win = Services.wm.getMostRecentWindow("navigator:browser");

      // Exponential backoff mechanism will delay the polling times if user doesn't
      // trigger SetDefaultBrowser for a long time.
      let backoffTimes = [1000, 1000, 1000, 1000, 2000, 2000, 2000, 5000, 5000, 10000];

      let pollForDefaultBrowser = () => {
        let uri = win.gBrowser.currentURI.spec;

        if ((uri == "about:preferences" || uri == "about:preferences#general") &&
          document.visibilityState == "visible") {
          this.updateSetDefaultBrowser();
        }

        // approximately a "requestIdleInterval"
        window.setTimeout(() => {
          window.requestIdleCallback(pollForDefaultBrowser);
        }, backoffTimes[this._backoffIndex + 1 < backoffTimes.length ?
          this._backoffIndex++ : backoffTimes.length - 1]);
      };

      window.setTimeout(() => {
        window.requestIdleCallback(pollForDefaultBrowser);
      }, backoffTimes[this._backoffIndex]);
    }

    this.initBrowserContainers();
    this.buildContentProcessCountMenuList();

    let performanceSettingsLink = document.getElementById("performanceSettingsLearnMore");
    let performanceSettingsUrl = Services.urlFormatter.formatURLPref("app.support.baseURL") + "performance";
    performanceSettingsLink.setAttribute("href", performanceSettingsUrl);

    this.updateDefaultPerformanceSettingsPref();

    let defaultPerformancePref =
      Preferences.get("browser.preferences.defaultPerformanceSettings.enabled");
    defaultPerformancePref.on("change", () => {
      this.updatePerformanceSettingsBox({ duringChangeEvent: true });
    });
    this.updatePerformanceSettingsBox({ duringChangeEvent: false });

    let connectionSettingsLink = document.getElementById("connectionSettingsLearnMore");
    let connectionSettingsUrl = Services.urlFormatter.formatURLPref("app.support.baseURL") +
                                "prefs-connection-settings";
    connectionSettingsLink.setAttribute("href", connectionSettingsUrl);
    this.updateProxySettingsUI();
    initializeProxyUI(gMainPane);

    if (Services.prefs.getBoolPref("intl.multilingual.enabled")) {
      gMainPane.initBrowserLocale();
    }

    if (AppConstants.platform == "win") {
      // Functionality for "Show tabs in taskbar" on Windows 7 and up.
      try {
        let ver = parseFloat(Services.sysinfo.getProperty("version"));
        let showTabsInTaskbar = document.getElementById("showTabsInTaskbar");
        showTabsInTaskbar.hidden = ver < 6.1;
      } catch (ex) { }
    }

    // The "closing multiple tabs" and "opening multiple tabs might slow down
    // &brandShortName;" warnings provide options for not showing these
    // warnings again. When the user disabled them, we provide checkboxes to
    // re-enable the warnings.
    if (!TransientPrefs.prefShouldBeVisible("browser.tabs.warnOnClose"))
      document.getElementById("warnCloseMultiple").hidden = true;
    if (!TransientPrefs.prefShouldBeVisible("browser.tabs.warnOnOpen"))
      document.getElementById("warnOpenMany").hidden = true;

    // Startup pref
    setEventListener("browserRestoreSession", "command",
      gMainPane.onBrowserRestoreSessionChange);
    gMainPane.updateBrowserStartupUI = gMainPane.updateBrowserStartupUI.bind(gMainPane);
    Preferences.get("browser.privatebrowsing.autostart").on("change",
      gMainPane.updateBrowserStartupUI);
    Preferences.get("browser.startup.page").on("change",
      gMainPane.updateBrowserStartupUI);
    Preferences.get("browser.startup.homepage").on("change",
      gMainPane.updateBrowserStartupUI);
    gMainPane.updateBrowserStartupUI();

    if (AppConstants.HAVE_SHELL_SERVICE) {
      setEventListener("setDefaultButton", "command",
        gMainPane.setDefaultBrowser);
    }
    setEventListener("disableContainersExtension", "command",
                     makeDisableControllingExtension(PREF_SETTING_TYPE, CONTAINERS_KEY));
    setEventListener("chooseLanguage", "command",
      gMainPane.showLanguages);
    setEventListener("translationAttributionImage", "click",
      gMainPane.openTranslationProviderAttribution);
    setEventListener("translateButton", "command",
      gMainPane.showTranslationExceptions);
    Preferences.get("font.language.group").on("change",
      gMainPane._rebuildFonts.bind(gMainPane));
    setEventListener("advancedFonts", "command",
      gMainPane.configureFonts);
    setEventListener("colors", "command",
      gMainPane.configureColors);
    Preferences.get("layers.acceleration.disabled").on("change",
      gMainPane.updateHardwareAcceleration.bind(gMainPane));
    setEventListener("connectionSettings", "command",
      gMainPane.showConnections);
    setEventListener("browserContainersCheckbox", "command",
      gMainPane.checkBrowserContainers);
    setEventListener("browserContainersSettings", "command",
      gMainPane.showContainerSettings);

    // Initializes the fonts dropdowns displayed in this pane.
    this._rebuildFonts();

    this.updateOnScreenKeyboardVisibility();

    // Show translation preferences if we may:
    const prefName = "browser.translation.ui.show";
    if (Services.prefs.getBoolPref(prefName)) {
      let row = document.getElementById("translationBox");
      row.removeAttribute("hidden");
      // Showing attribution only for Bing Translator.
      ChromeUtils.import("resource:///modules/translation/Translation.jsm");
      if (Translation.translationEngine == "bing") {
        document.getElementById("bingAttribution").removeAttribute("hidden");
      }
    }

    if (AppConstants.MOZ_DEV_EDITION) {
      let uAppData = OS.Constants.Path.userApplicationDataDir;
      let ignoreSeparateProfile = OS.Path.join(uAppData, "ignore-dev-edition-profile");

      setEventListener("separateProfileMode", "command", gMainPane.separateProfileModeChange);
      let separateProfileModeCheckbox = document.getElementById("separateProfileMode");
      setEventListener("getStarted", "click", gMainPane.onGetStarted);

      OS.File.stat(ignoreSeparateProfile).then(() => separateProfileModeCheckbox.checked = false,
        () => separateProfileModeCheckbox.checked = true);

      if (Services.prefs.getBoolPref("identity.fxaccounts.enabled")) {
        document.getElementById("sync-dev-edition-root").hidden = false;
        fxAccounts.getSignedInUser().then(data => {
          document.getElementById("getStarted").selectedIndex = data ? 1 : 0;
        }).catch(Cu.reportError);
      }
    }

    // Initialize the Firefox Updates section.
    let version = AppConstants.MOZ_APP_VERSION_DISPLAY;

    // Include the build ID if this is an "a#" (nightly) build
    if (/a\d+$/.test(version)) {
      let buildID = Services.appinfo.appBuildID;
      let year = buildID.slice(0, 4);
      let month = buildID.slice(4, 6);
      let day = buildID.slice(6, 8);
      version += ` (${year}-${month}-${day})`;
    }

    // Append "(32-bit)" or "(64-bit)" build architecture to the version number:
    let bundle = Services.strings.createBundle("chrome://browser/locale/browser.properties");
    let archResource = Services.appinfo.is64Bit
      ? "aboutDialog.architecture.sixtyFourBit"
      : "aboutDialog.architecture.thirtyTwoBit";
    let arch = bundle.GetStringFromName(archResource);
    version += ` (${arch})`;

    document.l10n.setAttributes(
      document.getElementById("updateAppInfo"),
      "update-application-version",
      { version }
    );

    // Show a release notes link if we have a URL.
    let relNotesLink = document.getElementById("releasenotes");
    let relNotesPrefType = Services.prefs.getPrefType("app.releaseNotesURL");
    if (relNotesPrefType != Services.prefs.PREF_INVALID) {
      let relNotesURL = Services.urlFormatter.formatURLPref("app.releaseNotesURL");
      if (relNotesURL != "about:blank") {
        relNotesLink.href = relNotesURL;
        relNotesLink.hidden = false;
      }
    }

    let distroId = Services.prefs.getCharPref("distribution.id", "");
    if (distroId) {
      let distroString = distroId;

      let distroVersion = Services.prefs.getCharPref("distribution.version", "");
      if (distroVersion) {
        distroString += " - " + distroVersion;
      }

      let distroIdField = document.getElementById("distributionId");
      distroIdField.value = distroString;
      distroIdField.hidden = false;

      let distroAbout = Services.prefs.getStringPref("distribution.about", "");
      if (distroAbout) {
        let distroField = document.getElementById("distribution");
        distroField.value = distroAbout;
        distroField.hidden = false;
      }
    }

    if (AppConstants.MOZ_UPDATER) {
      gAppUpdater = new appUpdater();
      setEventListener("showUpdateHistory", "command",
        gMainPane.showUpdates);

      if (Services.policies && !Services.policies.isAllowed("appUpdate")) {
        document.getElementById("updateAllowDescription").hidden = true;
        document.getElementById("updateRadioGroup").hidden = true;
        if (AppConstants.MOZ_MAINTENANCE_SERVICE) {
          document.getElementById("useService").hidden = true;
        }
      }

      if (AppConstants.MOZ_MAINTENANCE_SERVICE) {
        // Check to see if the maintenance service is installed.
        // If it isn't installed, don't show the preference at all.
        let installed;
        try {
          let wrk = Cc["@mozilla.org/windows-registry-key;1"]
                    .createInstance(Ci.nsIWindowsRegKey);
          wrk.open(wrk.ROOT_KEY_LOCAL_MACHINE,
                   "SOFTWARE\\Mozilla\\MaintenanceService",
                   wrk.ACCESS_READ | wrk.WOW64_64);
          installed = wrk.readIntValue("Installed");
          wrk.close();
        } catch (e) {
        }
        if (installed != 1) {
          document.getElementById("useService").hidden = true;
        }
      }
    }

    // Initilize Application section.

    // Observe preferences that influence what we display so we can rebuild
    // the view when they change.
    Services.prefs.addObserver(PREF_SHOW_PLUGINS_IN_LIST, this);
    Services.prefs.addObserver(PREF_HIDE_PLUGINS_WITHOUT_EXTENSIONS, this);
    Services.prefs.addObserver(PREF_FEED_SELECTED_APP, this);
    Services.prefs.addObserver(PREF_FEED_SELECTED_ACTION, this);
    Services.prefs.addObserver(PREF_FEED_SELECTED_READER, this);

    Services.prefs.addObserver(PREF_VIDEO_FEED_SELECTED_APP, this);
    Services.prefs.addObserver(PREF_VIDEO_FEED_SELECTED_ACTION, this);
    Services.prefs.addObserver(PREF_VIDEO_FEED_SELECTED_READER, this);

    Services.prefs.addObserver(PREF_AUDIO_FEED_SELECTED_APP, this);
    Services.prefs.addObserver(PREF_AUDIO_FEED_SELECTED_ACTION, this);
    Services.prefs.addObserver(PREF_AUDIO_FEED_SELECTED_READER, this);

    setEventListener("filter", "command", gMainPane.filter);
    setEventListener("typeColumn", "click", gMainPane.sort);
    setEventListener("actionColumn", "click", gMainPane.sort);
    setEventListener("chooseFolder", "command", gMainPane.chooseFolder);
    setEventListener("saveWhere", "command", gMainPane.handleSaveToCommand);
    Preferences.get("browser.download.folderList").on("change",
      gMainPane.displayDownloadDirPref.bind(gMainPane));
    Preferences.get("browser.download.dir").on("change",
      gMainPane.displayDownloadDirPref.bind(gMainPane));
    gMainPane.displayDownloadDirPref();

    // Listen for window unload so we can remove our preference observers.
    window.addEventListener("unload", this);

    // Figure out how we should be sorting the list.  We persist sort settings
    // across sessions, so we can't assume the default sort column/direction.
    // XXX should we be using the XUL sort service instead?
    if (document.getElementById("actionColumn").hasAttribute("sortDirection")) {
      this._sortColumn = document.getElementById("actionColumn");
      // The typeColumn element always has a sortDirection attribute,
      // either because it was persisted or because the default value
      // from the xul file was used.  If we are sorting on the other
      // column, we should remove it.
      document.getElementById("typeColumn").removeAttribute("sortDirection");
    } else {
      this._sortColumn = document.getElementById("typeColumn");
    }

    let browserBundle = document.getElementById("browserBundle");
    appendSearchKeywords("browserContainersSettings", [
      browserBundle.getString("userContextPersonal.label"),
      browserBundle.getString("userContextWork.label"),
      browserBundle.getString("userContextBanking.label"),
      browserBundle.getString("userContextShopping.label"),
    ]);

    // Notify observers that the UI is now ready
    Services.obs.notifyObservers(window, "main-pane-loaded");
  },

  preInit() {
    promiseLoadHandlersList = new Promise((resolve, reject) => {
      // Load the data and build the list of handlers for applications pane.
      // By doing this after pageshow, we ensure it doesn't delay painting
      // of the preferences page.
      window.addEventListener("pageshow", async () => {
        try {
          this._initListEventHandlers();
          this._loadData();
          await this._rebuildVisibleTypes();
          this._sortVisibleTypes();
          this._rebuildView();
          resolve();
        } catch (ex) {
          reject(ex);
        }
      }, { once: true });
    });
  },

  // CONTAINERS

  /*
   * preferences:
   *
   * privacy.userContext.enabled
   * - true if containers is enabled
   */

  /**
   * Enables/disables the Settings button used to configure containers
   */
  readBrowserContainersCheckbox() {
    const pref = Preferences.get("privacy.userContext.enabled");
    const settings = document.getElementById("browserContainersSettings");

    settings.disabled = !pref.value;
    const containersEnabled = Services.prefs.getBoolPref("privacy.userContext.enabled");
    const containersCheckbox = document.getElementById("browserContainersCheckbox");
    containersCheckbox.checked = containersEnabled;
    handleControllingExtension(PREF_SETTING_TYPE, CONTAINERS_KEY)
      .then((isControlled) => {
        containersCheckbox.disabled = isControlled;
      });
  },

  /**
   * Show the Containers UI depending on the privacy.userContext.ui.enabled pref.
   */
  initBrowserContainers() {
    if (!Services.prefs.getBoolPref("privacy.userContext.ui.enabled")) {
      // The browserContainersGroup element has its own internal padding that
      // is visible even if the browserContainersbox is visible, so hide the whole
      // groupbox if the feature is disabled to prevent a gap in the preferences.
      document.getElementById("browserContainersbox").setAttribute("data-hidden-from-search", "true");
      return;
    }
    Services.prefs.addObserver(PREF_CONTAINERS_EXTENSION, this);

    const link = document.getElementById("browserContainersLearnMore");
    link.href = Services.urlFormatter.formatURLPref("app.support.baseURL") + "containers";

    document.getElementById("browserContainersbox").hidden = false;
    this.readBrowserContainersCheckbox();
  },

  async separateProfileModeChange() {
    if (AppConstants.MOZ_DEV_EDITION) {
      function quitApp() {
        Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestartNotSameProfile);
      }
      function revertCheckbox(error) {
        separateProfileModeCheckbox.checked = !separateProfileModeCheckbox.checked;
        if (error) {
          Cu.reportError("Failed to toggle separate profile mode: " + error);
        }
      }
      function createOrRemoveSpecialDevEditionFile(onSuccess) {
        let uAppData = OS.Constants.Path.userApplicationDataDir;
        let ignoreSeparateProfile = OS.Path.join(uAppData, "ignore-dev-edition-profile");

        if (separateProfileModeCheckbox.checked) {
          OS.File.remove(ignoreSeparateProfile).then(onSuccess, revertCheckbox);
        } else {
          OS.File.writeAtomic(ignoreSeparateProfile, new Uint8Array()).then(onSuccess, revertCheckbox);
        }
      }

      let separateProfileModeCheckbox = document.getElementById("separateProfileMode");
      let button_index = await confirmRestartPrompt(separateProfileModeCheckbox.checked,
        0, false, true);
      switch (button_index) {
        case CONFIRM_RESTART_PROMPT_CANCEL:
          revertCheckbox();
          return;
        case CONFIRM_RESTART_PROMPT_RESTART_NOW:
          let cancelQuit = Cc["@mozilla.org/supports-PRBool;1"]
            .createInstance(Ci.nsISupportsPRBool);
          Services.obs.notifyObservers(cancelQuit, "quit-application-requested",
            "restart");
          if (!cancelQuit.data) {
            createOrRemoveSpecialDevEditionFile(quitApp);
            return;
          }

          // Revert the checkbox in case we didn't quit
          revertCheckbox();
          return;
        case CONFIRM_RESTART_PROMPT_RESTART_LATER:
          createOrRemoveSpecialDevEditionFile();
      }
    }
  },

  async onGetStarted(aEvent) {
    if (!AppConstants.MOZ_DEV_EDITION) {
      return;
    }
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    if (!win) {
      return;
    }
    const user = await fxAccounts.getSignedInUser();
    if (user) {
      // We have a user, open Sync preferences in the same tab
      win.openTrustedLinkIn("about:preferences#sync", "current");
      return;
    }
    let url = await FxAccounts.config.promiseSignInURI("dev-edition-setup");
    let accountsTab = win.gBrowser.addWebTab(url);
    win.gBrowser.selectedTab = accountsTab;
  },

  // HOME PAGE
  /*
   * Preferences:
   *
   * browser.startup.page
   * - what page(s) to show when the user starts the application, as an integer:
   *
   *     0: a blank page (DEPRECATED - this can be set via browser.startup.homepage)
   *     1: the home page (as set by the browser.startup.homepage pref)
   *     2: the last page the user visited (DEPRECATED)
   *     3: windows and tabs from the last session (a.k.a. session restore)
   *
   *   The deprecated option is not exposed in UI; however, if the user has it
   *   selected and doesn't change the UI for this preference, the deprecated
   *   option is preserved.
   */

  /**
   * Utility function to enable/disable the button specified by aButtonID based
   * on the value of the Boolean preference specified by aPreferenceID.
   */
  updateButtons(aButtonID, aPreferenceID) {
    var button = document.getElementById(aButtonID);
    var preference = Preferences.get(aPreferenceID);
    button.disabled = !preference.value;
    return undefined;
  },

  /**
   * Hide/show the "Show my windows and tabs from last time" option based
   * on the value of the browser.privatebrowsing.autostart pref.
   */
  updateBrowserStartupUI() {
    const pbAutoStartPref = Preferences.get("browser.privatebrowsing.autostart");
    const startupPref = Preferences.get("browser.startup.page");

    let newValue;
    let checkbox = document.getElementById("browserRestoreSession");
    if (pbAutoStartPref.value || startupPref.locked) {
      checkbox.setAttribute("disabled", "true");
      newValue = false;
    } else {
      checkbox.removeAttribute("disabled");
      newValue = startupPref.value === this.STARTUP_PREF_RESTORE_SESSION;
    }
    if (checkbox.checked !== newValue) {
      checkbox.checked = newValue;
    }
  },

  initBrowserLocale() {
    let localeCodes = Services.locale.getAvailableLocales();
    let localeNames = Services.intl.getLocaleDisplayNames(undefined, localeCodes);
    let locales = localeCodes.map((code, i) => ({code, name: localeNames[i]}));
    locales.sort((a, b) => a.name > b.name);

    let fragment = document.createDocumentFragment();
    for (let {code, name} of locales) {
      let menuitem = document.createXULElement("menuitem");
      menuitem.setAttribute("value", code);
      menuitem.setAttribute("label", name);
      fragment.appendChild(menuitem);
    }
    let menulist = document.getElementById("defaultBrowserLanguage");
    let menupopup = menulist.querySelector("menupopup");
    menupopup.appendChild(fragment);
    menulist.value = Services.locale.getRequestedLocale();

    document.getElementById("browserLanguagesBox").hidden = false;
  },

  /* Show the confirmation message bar to allow a restart into the new language. */
  async onBrowserLanguageChange(event) {
    let locale = event.target.value;
    let messageBar = document.getElementById("confirmBrowserLanguage");
    if (locale == Services.locale.getRequestedLocale()) {
      messageBar.hidden = true;
      return;
    }
    // Set the text in the message bar for the new locale.
    let newBundle = getBundleForLocale(locale);
    let description = messageBar.querySelector("description");
    description.textContent = await newBundle.formatValue(
      "confirm-browser-language-change-description");
    let button = messageBar.querySelector("button");
    button.setAttribute(
      "label", await newBundle.formatValue(
        "confirm-browser-language-change-button"));
    messageBar.hidden = false;
  },

  /* Confirm the locale change and restart the browser in the new locale. */
  confirmBrowserLanguageChange() {
    let locale = document.getElementById("defaultBrowserLanguage").value;
    Services.locale.setRequestedLocales([locale]);

    // Restart with the new locale.
    let cancelQuit = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
    Services.obs.notifyObservers(cancelQuit, "quit-application-requested", "restart");
    if (!cancelQuit.data) {
      Services.startup.quit(Services.startup.eAttemptQuit | Services.startup.eRestart);
    }
  },

  onBrowserRestoreSessionChange(event) {
    const value = event.target.checked;
    const startupPref = Preferences.get("browser.startup.page");
    let newValue;

    if (value) {
      // We need to restore the blank homepage setting in our other pref
      if (startupPref.value === this.STARTUP_PREF_BLANK) {
        Preferences.get("browser.startup.homepage").value = "about:blank";
      }
      newValue = this.STARTUP_PREF_RESTORE_SESSION;
    } else {
      newValue = this.STARTUP_PREF_HOMEPAGE;
    }
    startupPref.value = newValue;
  },

  // TABS

  /*
   * Preferences:
   *
   * browser.link.open_newwindow - int
   *   Determines where links targeting new windows should open.
   *   Values:
   *     1 - Open in the current window or tab.
   *     2 - Open in a new window.
   *     3 - Open in a new tab in the most recent window.
   * browser.tabs.loadInBackground - bool
   *   True - Whether browser should switch to a new tab opened from a link.
   * browser.tabs.warnOnClose - bool
   *   True - If when closing a window with multiple tabs the user is warned and
   *          allowed to cancel the action, false to just close the window.
   * browser.tabs.warnOnOpen - bool
   *   True - Whether the user should be warned when trying to open a lot of
   *          tabs at once (e.g. a large folder of bookmarks), allowing to
   *          cancel the action.
   * browser.taskbar.previews.enable - bool
   *   True - Tabs are to be shown in Windows 7 taskbar.
   *   False - Only the window is to be shown in Windows 7 taskbar.
   */

  /**
   * Determines where a link which opens a new window will open.
   *
   * @returns |true| if such links should be opened in new tabs
   */
  readLinkTarget() {
    var openNewWindow = Preferences.get("browser.link.open_newwindow");
    return openNewWindow.value != 2;
  },

  /**
   * Determines where a link which opens a new window will open.
   *
   * @returns 2 if such links should be opened in new windows,
   *          3 if such links should be opened in new tabs
   */
  writeLinkTarget() {
    var linkTargeting = document.getElementById("linkTargeting");
    return linkTargeting.checked ? 3 : 2;
  },
  /*
   * Preferences:
   *
   * browser.shell.checkDefault
   * - true if a default-browser check (and prompt to make it so if necessary)
   *   occurs at startup, false otherwise
   */

  /**
   * Show button for setting browser as default browser or information that
   * browser is already the default browser.
   */
  updateSetDefaultBrowser() {
    if (AppConstants.HAVE_SHELL_SERVICE) {
      let shellSvc = getShellService();
      let defaultBrowserBox = document.getElementById("defaultBrowserBox");
      if (!shellSvc) {
        defaultBrowserBox.hidden = true;
        return;
      }
      let setDefaultPane = document.getElementById("setDefaultPane");
      let isDefault = shellSvc.isDefaultBrowser(false, true);
      setDefaultPane.selectedIndex = isDefault ? 1 : 0;
      let alwaysCheck = document.getElementById("alwaysCheckDefault");
      alwaysCheck.disabled = alwaysCheck.disabled ||
        isDefault && alwaysCheck.checked;
    }
  },

  /**
   * Set browser as the operating system default browser.
   */
  setDefaultBrowser() {
    if (AppConstants.HAVE_SHELL_SERVICE) {
      let alwaysCheckPref = Preferences.get("browser.shell.checkDefaultBrowser");
      alwaysCheckPref.value = true;

      // Reset exponential backoff delay time in order to do visual update in pollForDefaultBrowser.
      this._backoffIndex = 0;

      let shellSvc = getShellService();
      if (!shellSvc)
        return;
      try {
        shellSvc.setDefaultBrowser(true, false);
      } catch (ex) {
        Cu.reportError(ex);
        return;
      }

      let selectedIndex = shellSvc.isDefaultBrowser(false, true) ? 1 : 0;
      document.getElementById("setDefaultPane").selectedIndex = selectedIndex;
    }
  },

  /**
   * Shows a dialog in which the preferred language for web content may be set.
   */
  showLanguages() {
    gSubDialog.open("chrome://browser/content/preferences/languages.xul");
  },

  /**
   * Displays the translation exceptions dialog where specific site and language
   * translation preferences can be set.
   */
  showTranslationExceptions() {
    gSubDialog.open("chrome://browser/content/preferences/translation.xul");
  },

  openTranslationProviderAttribution() {
    ChromeUtils.import("resource:///modules/translation/Translation.jsm");
    Translation.openProviderAttribution();
  },

  /**
   * Displays the fonts dialog, where web page font names and sizes can be
   * configured.
   */
  configureFonts() {
    gSubDialog.open("chrome://browser/content/preferences/fonts.xul", "resizable=no");
  },

  /**
   * Displays the colors dialog, where default web page/link/etc. colors can be
   * configured.
   */
  configureColors() {
    gSubDialog.open("chrome://browser/content/preferences/colors.xul", "resizable=no");
  },

  // NETWORK
  /**
   * Displays a dialog in which proxy settings may be changed.
   */
  showConnections() {
    gSubDialog.open("chrome://browser/content/preferences/connection.xul",
                    null, null, this.updateProxySettingsUI.bind(this));
  },

  // Update the UI to show the proper description depending on whether an
  // extension is in control or not.
  async updateProxySettingsUI() {
    let controllingExtension = await getControllingExtension(PREF_SETTING_TYPE, PROXY_KEY);
    let description = document.getElementById("connectionSettingsDescription");

    if (controllingExtension) {
      setControllingExtensionDescription(description, controllingExtension, "proxy.settings");
    } else {
      setControllingExtensionDescription(description, null, "network-proxy-connection-description");
    }
  },

  async checkBrowserContainers(event) {
    let checkbox = document.getElementById("browserContainersCheckbox");
    if (checkbox.checked) {
      Services.prefs.setBoolPref("privacy.userContext.enabled", true);
      return;
    }

    let count = ContextualIdentityService.countContainerTabs();
    if (count == 0) {
      Services.prefs.setBoolPref("privacy.userContext.enabled", false);
      return;
    }

    let [
      title, message, okButton, cancelButton
    ] = await document.l10n.formatValues([
      {id: "containers-disable-alert-title"},
      {id: "containers-disable-alert-desc", args: { tabCount: count }},
      {id: "containers-disable-alert-ok-button", args: { tabCount: count }},
      {id: "containers-disable-alert-cancel-button"}
    ]);

    let buttonFlags = (Ci.nsIPrompt.BUTTON_TITLE_IS_STRING * Ci.nsIPrompt.BUTTON_POS_0) +
      (Ci.nsIPrompt.BUTTON_TITLE_IS_STRING * Ci.nsIPrompt.BUTTON_POS_1);

    let rv = Services.prompt.confirmEx(window, title, message, buttonFlags,
      okButton, cancelButton, null, null, {});
    if (rv == 0) {
      Services.prefs.setBoolPref("privacy.userContext.enabled", false);
      return;
    }

    checkbox.checked = true;
  },

  /**
   * Displays container panel for customising and adding containers.
   */
  showContainerSettings() {
    gotoPref("containers");
  },

  /**
   * ui.osk.enabled
   * - when set to true, subject to other conditions, we may sometimes invoke
   *   an on-screen keyboard when a text input is focused.
   *   (Currently Windows-only, and depending on prefs, may be Windows-8-only)
   */
  updateOnScreenKeyboardVisibility() {
    if (AppConstants.platform == "win") {
      let minVersion = Services.prefs.getBoolPref("ui.osk.require_win10") ? 10 : 6.2;
      if (Services.vc.compare(Services.sysinfo.getProperty("version"), minVersion) >= 0) {
        document.getElementById("useOnScreenKeyboard").hidden = false;
      }
    }
  },

  updateHardwareAcceleration() {
    // Placeholder for restart on change
  },

  // FONTS

  /**
   * Populates the default font list in UI.
   */
  _rebuildFonts() {
    var langGroupPref = Preferences.get("font.language.group");
    var isSerif = this._readDefaultFontTypeForLanguage(langGroupPref.value) == "serif";
    this._selectDefaultLanguageGroup(langGroupPref.value, isSerif);
  },

  /**
   * Returns the type of the current default font for the language denoted by
   * aLanguageGroup.
   */
  _readDefaultFontTypeForLanguage(aLanguageGroup) {
    const kDefaultFontType = "font.default.%LANG%";
    var defaultFontTypePref = kDefaultFontType.replace(/%LANG%/, aLanguageGroup);
    var preference = Preferences.get(defaultFontTypePref);
    if (!preference) {
      preference = Preferences.add({ id: defaultFontTypePref, type: "string" });
      preference.on("change", gMainPane._rebuildFonts.bind(gMainPane));
    }
    return preference.value;
  },

  _selectDefaultLanguageGroupPromise: Promise.resolve(),

  _selectDefaultLanguageGroup(aLanguageGroup, aIsSerif) {
    this._selectDefaultLanguageGroupPromise = (async () => {
      // Avoid overlapping language group selections by awaiting the resolution
      // of the previous one.  We do this because this function is re-entrant,
      // as inserting <preference> elements into the DOM sometimes triggers a call
      // back into this function.  And since this function is also asynchronous,
      // that call can enter this function before the previous run has completed,
      // which would corrupt the font menulists.  Awaiting the previous call's
      // resolution avoids that fate.
      await this._selectDefaultLanguageGroupPromise;

      const kFontNameFmtSerif = "font.name.serif.%LANG%";
      const kFontNameFmtSansSerif = "font.name.sans-serif.%LANG%";
      const kFontNameListFmtSerif = "font.name-list.serif.%LANG%";
      const kFontNameListFmtSansSerif = "font.name-list.sans-serif.%LANG%";
      const kFontSizeFmtVariable = "font.size.variable.%LANG%";

      var prefs = [{
        format: aIsSerif ? kFontNameFmtSerif : kFontNameFmtSansSerif,
        type: "fontname",
        element: "defaultFont",
        fonttype: aIsSerif ? "serif" : "sans-serif"
      },
      {
        format: aIsSerif ? kFontNameListFmtSerif : kFontNameListFmtSansSerif,
        type: "unichar",
        element: null,
        fonttype: aIsSerif ? "serif" : "sans-serif"
      },
      {
        format: kFontSizeFmtVariable,
        type: "int",
        element: "defaultFontSize",
        fonttype: null
      }];
      for (var i = 0; i < prefs.length; ++i) {
        var preference = Preferences.get(prefs[i].format.replace(/%LANG%/, aLanguageGroup));
        if (!preference) {
          var name = prefs[i].format.replace(/%LANG%/, aLanguageGroup);
          preference = Preferences.add({ id: name, type: prefs[i].type });
        }

        if (!prefs[i].element)
          continue;

        var element = document.getElementById(prefs[i].element);
        if (element) {
          element.setAttribute("preference", preference.id);

          if (prefs[i].fonttype)
            await FontBuilder.buildFontList(aLanguageGroup, prefs[i].fonttype, element);

          preference.setElementValue(element);
        }
      }
    })()
      .catch(Cu.reportError);
  },

  /**
   * Stores the original value of the spellchecking preference to enable proper
   * restoration if unchanged (since we're mapping a tristate onto a checkbox).
   */
  _storedSpellCheck: 0,

  /**
   * Returns true if any spellchecking is enabled and false otherwise, caching
   * the current value to enable proper pref restoration if the checkbox is
   * never changed.
   *
   * layout.spellcheckDefault
   * - an integer:
   *     0  disables spellchecking
   *     1  enables spellchecking, but only for multiline text fields
   *     2  enables spellchecking for all text fields
   */
  readCheckSpelling() {
    var pref = Preferences.get("layout.spellcheckDefault");
    this._storedSpellCheck = pref.value;

    return (pref.value != 0);
  },

  /**
   * Returns the value of the spellchecking preference represented by UI,
   * preserving the preference's "hidden" value if the preference is
   * unchanged and represents a value not strictly allowed in UI.
   */
  writeCheckSpelling() {
    var checkbox = document.getElementById("checkSpelling");
    if (checkbox.checked) {
      if (this._storedSpellCheck == 2) {
        return 2;
      }
      return 1;
    }
    return 0;
  },

  updateDefaultPerformanceSettingsPref() {
    let defaultPerformancePref =
      Preferences.get("browser.preferences.defaultPerformanceSettings.enabled");
    let processCountPref = Preferences.get("dom.ipc.processCount");
    let accelerationPref = Preferences.get("layers.acceleration.disabled");
    if (processCountPref.value != processCountPref.defaultValue ||
      accelerationPref.value != accelerationPref.defaultValue) {
      defaultPerformancePref.value = false;
    }
  },

  updatePerformanceSettingsBox({ duringChangeEvent }) {
    let defaultPerformancePref =
      Preferences.get("browser.preferences.defaultPerformanceSettings.enabled");
    let performanceSettings = document.getElementById("performanceSettings");
    let processCountPref = Preferences.get("dom.ipc.processCount");
    if (defaultPerformancePref.value) {
      let accelerationPref = Preferences.get("layers.acceleration.disabled");
      // Unset the value so process count will be decided by the platform.
      processCountPref.value = processCountPref.defaultValue;
      accelerationPref.value = accelerationPref.defaultValue;
      performanceSettings.hidden = true;
    } else {
      performanceSettings.hidden = false;
    }
  },

  buildContentProcessCountMenuList() {
    if (Services.appinfo.browserTabsRemoteAutostart) {
      let processCountPref = Preferences.get("dom.ipc.processCount");
      let defaultProcessCount = processCountPref.defaultValue;

      let contentProcessCount =
        document.querySelector(`#contentProcessCount > menupopup >
                                menuitem[value="${defaultProcessCount}"]`);

      document.l10n.setAttributes(
        contentProcessCount,
        "performance-default-content-process-count",
        { num: defaultProcessCount });

      document.getElementById("limitContentProcess").disabled = false;
      document.getElementById("contentProcessCount").disabled = false;
      document.getElementById("contentProcessCountEnabledDescription").hidden = false;
      document.getElementById("contentProcessCountDisabledDescription").hidden = true;
    } else {
      document.getElementById("limitContentProcess").disabled = true;
      document.getElementById("contentProcessCount").disabled = true;
      document.getElementById("contentProcessCountEnabledDescription").hidden = true;
      document.getElementById("contentProcessCountDisabledDescription").hidden = false;
    }
  },

  /**
   * Displays the history of installed updates.
   */
  showUpdates() {
    gSubDialog.open("chrome://mozapps/content/update/history.xul");
  },

  destroy() {
    window.removeEventListener("unload", this);
    Services.prefs.removeObserver(PREF_SHOW_PLUGINS_IN_LIST, this);
    Services.prefs.removeObserver(PREF_HIDE_PLUGINS_WITHOUT_EXTENSIONS, this);
    Services.prefs.removeObserver(PREF_FEED_SELECTED_APP, this);
    Services.prefs.removeObserver(PREF_FEED_SELECTED_ACTION, this);
    Services.prefs.removeObserver(PREF_FEED_SELECTED_READER, this);

    Services.prefs.removeObserver(PREF_VIDEO_FEED_SELECTED_APP, this);
    Services.prefs.removeObserver(PREF_VIDEO_FEED_SELECTED_ACTION, this);
    Services.prefs.removeObserver(PREF_VIDEO_FEED_SELECTED_READER, this);

    Services.prefs.removeObserver(PREF_AUDIO_FEED_SELECTED_APP, this);
    Services.prefs.removeObserver(PREF_AUDIO_FEED_SELECTED_ACTION, this);
    Services.prefs.removeObserver(PREF_AUDIO_FEED_SELECTED_READER, this);

    Services.prefs.removeObserver(PREF_CONTAINERS_EXTENSION, this);
  },


  // nsISupports

  QueryInterface: ChromeUtils.generateQI([Ci.nsIObserver]),

  // nsIObserver

  async observe(aSubject, aTopic, aData) {
    if (aTopic == "nsPref:changed") {
      if (aData == PREF_CONTAINERS_EXTENSION) {
        this.readBrowserContainersCheckbox();
        return;
      }
      // Rebuild the list when there are changes to preferences that influence
      // whether or not to show certain entries in the list.
      if (!this._storingAction) {
        // These two prefs alter the list of visible types, so we have to rebuild
        // that list when they change.
        if (aData == PREF_SHOW_PLUGINS_IN_LIST ||
          aData == PREF_HIDE_PLUGINS_WITHOUT_EXTENSIONS) {
          await this._rebuildVisibleTypes();
          this._sortVisibleTypes();
        }

        // All the prefs we observe can affect what we display, so we rebuild
        // the view when any of them changes.
        this._rebuildView();
      }
    }
  },


  // EventListener

  handleEvent(aEvent) {
    if (aEvent.type == "unload") {
      this.destroy();
    }
  },


  // Composed Model Construction

  _loadData() {
    this._loadFeedHandler();
    this._loadInternalHandlers();
    this._loadPluginHandlers();
    this._loadApplicationHandlers();
  },

  _loadFeedHandler() {
    this._handledTypes[TYPE_MAYBE_FEED] = feedHandlerInfo;
    feedHandlerInfo.handledOnlyByPlugin = false;

    this._handledTypes[TYPE_MAYBE_VIDEO_FEED] = videoFeedHandlerInfo;
    videoFeedHandlerInfo.handledOnlyByPlugin = false;

    this._handledTypes[TYPE_MAYBE_AUDIO_FEED] = audioFeedHandlerInfo;
    audioFeedHandlerInfo.handledOnlyByPlugin = false;
  },

  /**
   * Load higher level internal handlers so they can be turned on/off in the
   * applications menu.
   */
  _loadInternalHandlers() {
    var internalHandlers = [new PDFHandlerInfoWrapper()];
    for (let internalHandler of internalHandlers) {
      if (internalHandler.enabled) {
        this._handledTypes[internalHandler.type] = internalHandler;
      }
    }
  },

  /**
   * Load the set of handlers defined by plugins.
   *
   * Note: if there's more than one plugin for a given MIME type, we assume
   * the last one is the one that the application will use.  That may not be
   * correct, but it's how we've been doing it for years.
   *
   * Perhaps we should instead query navigator.mimeTypes for the set of types
   * supported by the application and then get the plugin from each MIME type's
   * enabledPlugin property.  But if there's a plugin for a type, we need
   * to know about it even if it isn't enabled, since we're going to give
   * the user an option to enable it.
   *
   * Also note that enabledPlugin does not get updated when
   * plugin.disable_full_page_plugin_for_types changes, so even if we could use
   * enabledPlugin to get the plugin that would be used, we'd still need to
   * check the pref ourselves to find out if it's enabled.
   */
  _loadPluginHandlers() {
    "use strict";

    let mimeTypes = navigator.mimeTypes;

    for (let mimeType of mimeTypes) {
      let handlerInfoWrapper;
      if (mimeType.type in this._handledTypes) {
        handlerInfoWrapper = this._handledTypes[mimeType.type];
      } else {
        let wrappedHandlerInfo =
          gMIMEService.getFromTypeAndExtension(mimeType.type, null);
        handlerInfoWrapper = new HandlerInfoWrapper(mimeType.type, wrappedHandlerInfo);
        handlerInfoWrapper.handledOnlyByPlugin = true;
        this._handledTypes[mimeType.type] = handlerInfoWrapper;
      }
      handlerInfoWrapper.pluginName = mimeType.enabledPlugin.name;
    }
  },

  /**
   * Load the set of handlers defined by the application datastore.
   */
  _loadApplicationHandlers() {
    for (let wrappedHandlerInfo of gHandlerService.enumerate()) {
      let type = wrappedHandlerInfo.type;

      let handlerInfoWrapper;
      if (type in this._handledTypes)
        handlerInfoWrapper = this._handledTypes[type];
      else {
        handlerInfoWrapper = new HandlerInfoWrapper(type, wrappedHandlerInfo);
        this._handledTypes[type] = handlerInfoWrapper;
      }

      handlerInfoWrapper.handledOnlyByPlugin = false;
    }
  },


  // View Construction

  selectedHandlerListItem: null,

  _initListEventHandlers() {
    this._list.addEventListener("select", event => {
      if (event.target != this._list) {
        return;
      }

      let handlerListItem = this._list.selectedItem &&
                            HandlerListItem.forNode(this._list.selectedItem);
      if (this.selectedHandlerListItem == handlerListItem) {
        return;
      }

      if (this.selectedHandlerListItem) {
        this.selectedHandlerListItem.showActionsMenu = false;
      }
      this.selectedHandlerListItem = handlerListItem;
      if (handlerListItem) {
        this.rebuildActionsMenu();
        handlerListItem.showActionsMenu = true;
      }
    });
  },

  async _rebuildVisibleTypes() {
    this._visibleTypes = [];

    // Map whose keys are string descriptions and values are references to the
    // first visible HandlerInfoWrapper that has this description. We use this
    // to determine whether or not to annotate descriptions with their types to
    // distinguish duplicate descriptions from each other.
    let visibleDescriptions = new Map();

    // Get the preferences that help determine what types to show.
    var showPlugins = Services.prefs.getBoolPref(PREF_SHOW_PLUGINS_IN_LIST);
    var hidePluginsWithoutExtensions =
      Services.prefs.getBoolPref(PREF_HIDE_PLUGINS_WITHOUT_EXTENSIONS);

    for (let type in this._handledTypes) {
      // Yield before processing each handler info object to avoid monopolizing
      // the main thread, as the objects are retrieved lazily, and retrieval
      // can be expensive on Windows.
      await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));

      let handlerInfo = this._handledTypes[type];

      // Hide plugins without associated extensions if so prefed so we don't
      // show a whole bunch of obscure types handled by plugins on Mac.
      // Note: though protocol types don't have extensions, we still show them;
      // the pref is only meant to be applied to MIME types, since plugins are
      // only associated with MIME types.
      // FIXME: should we also check the "suffixes" property of the plugin?
      // Filed as bug 395135.
      if (hidePluginsWithoutExtensions && handlerInfo.handledOnlyByPlugin &&
        handlerInfo.wrappedHandlerInfo instanceof Ci.nsIMIMEInfo &&
        !handlerInfo.primaryExtension)
        continue;

      // Hide types handled only by plugins if so prefed.
      if (handlerInfo.handledOnlyByPlugin && !showPlugins)
        continue;

      // We couldn't find any reason to exclude the type, so include it.
      this._visibleTypes.push(handlerInfo);

      let otherHandlerInfo = visibleDescriptions.get(handlerInfo.description);
      if (!otherHandlerInfo) {
        // This is the first type with this description that we encountered
        // while rebuilding the _visibleTypes array this time. Make sure the
        // flag is reset so we won't add the type to the description.
        handlerInfo.disambiguateDescription = false;
        visibleDescriptions.set(handlerInfo.description, handlerInfo);
      } else {
        // There is at least another type with this description. Make sure we
        // add the type to the description on both HandlerInfoWrapper objects.
        handlerInfo.disambiguateDescription = true;
        otherHandlerInfo.disambiguateDescription = true;
      }
    }
  },

  _rebuildView() {
    let lastSelectedType = this.selectedHandlerListItem &&
                           this.selectedHandlerListItem.handlerInfoWrapper.type;
    this.selectedHandlerListItem = null;

    // Clear the list of entries.
    while (this._list.childNodes.length > 1)
      this._list.removeChild(this._list.lastChild);

    var visibleTypes = this._visibleTypes;

    // If the user is filtering the list, then only show matching types.
    if (this._filter.value)
      visibleTypes = visibleTypes.filter(this._matchesFilter, this);

    for (let visibleType of visibleTypes) {
      let item = new HandlerListItem(visibleType);
      item.connectAndAppendToList(this._list);

      if (visibleType.type === lastSelectedType) {
        this._list.selectedItem = item.node;
      }
    }
  },

  _matchesFilter(aType) {
    var filterValue = this._filter.value.toLowerCase();
    return aType.typeDescription.toLowerCase().includes(filterValue) ||
           aType.actionDescription.toLowerCase().includes(filterValue);
  },

  /**
   * Whether or not the given handler app is valid.
   *
   * @param aHandlerApp {nsIHandlerApp} the handler app in question
   *
   * @returns {boolean} whether or not it's valid
   */
  isValidHandlerApp(aHandlerApp) {
    if (!aHandlerApp)
      return false;

    if (aHandlerApp instanceof Ci.nsILocalHandlerApp)
      return this._isValidHandlerExecutable(aHandlerApp.executable);

    if (aHandlerApp instanceof Ci.nsIWebHandlerApp)
      return aHandlerApp.uriTemplate;

    if (aHandlerApp instanceof Ci.nsIGIOMimeApp)
      return aHandlerApp.command;

    return false;
  },

  _isValidHandlerExecutable(aExecutable) {
    let leafName;
    if (AppConstants.platform == "win") {
      leafName = `${AppConstants.MOZ_APP_NAME}.exe`;
    } else if (AppConstants.platform == "macosx") {
      leafName = AppConstants.MOZ_MACBUNDLE_NAME;
    } else {
      leafName = `${AppConstants.MOZ_APP_NAME}-bin`;
    }
    return aExecutable &&
      aExecutable.exists() &&
      aExecutable.isExecutable() &&
      // XXXben - we need to compare this with the running instance executable
      //          just don't know how to do that via script...
      // XXXmano TBD: can probably add this to nsIShellService
      aExecutable.leafName != leafName;
  },

  /**
   * Rebuild the actions menu for the selected entry.  Gets called by
   * the richlistitem constructor when an entry in the list gets selected.
   */
  rebuildActionsMenu() {
    var typeItem = this._list.selectedItem;
    var handlerInfo = this.selectedHandlerListItem.handlerInfoWrapper;
    var menu = typeItem.querySelector(".actionsMenu");
    var menuPopup = menu.menupopup;

    // Clear out existing items.
    while (menuPopup.hasChildNodes())
      menuPopup.removeChild(menuPopup.lastChild);

    let internalMenuItem;
    // Add the "Preview in Firefox" option for optional internal handlers.
    if (handlerInfo instanceof InternalHandlerInfoWrapper) {
      internalMenuItem = document.createXULElement("menuitem");
      internalMenuItem.setAttribute("action", Ci.nsIHandlerInfo.handleInternally);
      let label = gMainPane._prefsBundle.getFormattedString("previewInApp",
        [this._brandShortName]);
      internalMenuItem.setAttribute("label", label);
      internalMenuItem.setAttribute("tooltiptext", label);
      internalMenuItem.setAttribute(APP_ICON_ATTR_NAME, "ask");
      menuPopup.appendChild(internalMenuItem);
    }

    {
      var askMenuItem = document.createXULElement("menuitem");
      askMenuItem.setAttribute("action", Ci.nsIHandlerInfo.alwaysAsk);
      let label;
      if (isFeedType(handlerInfo.type))
        label = gMainPane._prefsBundle.getFormattedString("previewInApp",
          [this._brandShortName]);
      else
        label = gMainPane._prefsBundle.getString("alwaysAsk");
      askMenuItem.setAttribute("label", label);
      askMenuItem.setAttribute("tooltiptext", label);
      askMenuItem.setAttribute(APP_ICON_ATTR_NAME, "ask");
      menuPopup.appendChild(askMenuItem);
    }

    // Create a menu item for saving to disk.
    // Note: this option isn't available to protocol types, since we don't know
    // what it means to save a URL having a certain scheme to disk, nor is it
    // available to feeds, since the feed code doesn't implement the capability.
    if ((handlerInfo.wrappedHandlerInfo instanceof Ci.nsIMIMEInfo) &&
      !isFeedType(handlerInfo.type)) {
      var saveMenuItem = document.createXULElement("menuitem");
      saveMenuItem.setAttribute("action", Ci.nsIHandlerInfo.saveToDisk);
      let label = gMainPane._prefsBundle.getString("saveFile");
      saveMenuItem.setAttribute("label", label);
      saveMenuItem.setAttribute("tooltiptext", label);
      saveMenuItem.setAttribute(APP_ICON_ATTR_NAME, "save");
      menuPopup.appendChild(saveMenuItem);
    }

    // If this is the feed type, add a Live Bookmarks item.
    if (isFeedType(handlerInfo.type)) {
      internalMenuItem = document.createXULElement("menuitem");
      internalMenuItem.setAttribute("action", Ci.nsIHandlerInfo.handleInternally);
      let label = gMainPane._prefsBundle.getFormattedString("addLiveBookmarksInApp",
        [this._brandShortName]);
      internalMenuItem.setAttribute("label", label);
      internalMenuItem.setAttribute("tooltiptext", label);
      internalMenuItem.setAttribute(APP_ICON_ATTR_NAME, "feed");
      menuPopup.appendChild(internalMenuItem);
    }

    // Add a separator to distinguish these items from the helper app items
    // that follow them.
    let menuseparator = document.createXULElement("menuseparator");
    menuPopup.appendChild(menuseparator);

    // Create a menu item for the OS default application, if any.
    if (handlerInfo.hasDefaultHandler) {
      var defaultMenuItem = document.createXULElement("menuitem");
      defaultMenuItem.setAttribute("action", Ci.nsIHandlerInfo.useSystemDefault);
      let label = gMainPane._prefsBundle.getFormattedString("useDefault",
        [handlerInfo.defaultDescription]);
      defaultMenuItem.setAttribute("label", label);
      defaultMenuItem.setAttribute("tooltiptext", handlerInfo.defaultDescription);
      defaultMenuItem.setAttribute("image", handlerInfo.iconURLForSystemDefault);

      menuPopup.appendChild(defaultMenuItem);
    }

    // Create menu items for possible handlers.
    let preferredApp = handlerInfo.preferredApplicationHandler;
    var possibleAppMenuItems = [];
    for (let possibleApp of handlerInfo.possibleApplicationHandlers.enumerate()) {
      if (!this.isValidHandlerApp(possibleApp))
        continue;

      let menuItem = document.createXULElement("menuitem");
      menuItem.setAttribute("action", Ci.nsIHandlerInfo.useHelperApp);
      let label;
      if (possibleApp instanceof Ci.nsILocalHandlerApp)
        label = getFileDisplayName(possibleApp.executable);
      else
        label = possibleApp.name;
      label = gMainPane._prefsBundle.getFormattedString("useApp", [label]);
      menuItem.setAttribute("label", label);
      menuItem.setAttribute("tooltiptext", label);
      menuItem.setAttribute("image", this._getIconURLForHandlerApp(possibleApp));

      // Attach the handler app object to the menu item so we can use it
      // to make changes to the datastore when the user selects the item.
      menuItem.handlerApp = possibleApp;

      menuPopup.appendChild(menuItem);
      possibleAppMenuItems.push(menuItem);
    }
    // Add gio handlers
    if (Cc["@mozilla.org/gio-service;1"]) {
      let gIOSvc = Cc["@mozilla.org/gio-service;1"].
                   getService(Ci.nsIGIOService);
      var gioApps = gIOSvc.getAppsForURIScheme(handlerInfo.type);
      let possibleHandlers = handlerInfo.possibleApplicationHandlers;
      for (let handler of gioApps.enumerate()) {
        // OS handler share the same name, it's most likely the same app, skipping...
        if (handler.name == handlerInfo.defaultDescription) {
          continue;
        }
        // Check if the handler is already in possibleHandlers
        let appAlreadyInHandlers = false;
        for (let i = possibleHandlers.length - 1; i >= 0; --i) {
          let app = possibleHandlers.queryElementAt(i, Ci.nsIHandlerApp);
          // nsGIOMimeApp::Equals is able to compare with nsILocalHandlerApp
          if (handler.equals(app)) {
            appAlreadyInHandlers = true;
            break;
          }
        }
        if (!appAlreadyInHandlers) {
          let menuItem = document.createXULElement("menuitem");
          menuItem.setAttribute("action", Ci.nsIHandlerInfo.useHelperApp);
          let label = gMainPane._prefsBundle.getFormattedString("useApp", [handler.name]);
          menuItem.setAttribute("label", label);
          menuItem.setAttribute("tooltiptext", label);
          menuItem.setAttribute("image", this._getIconURLForHandlerApp(handler));

          // Attach the handler app object to the menu item so we can use it
          // to make changes to the datastore when the user selects the item.
          menuItem.handlerApp = handler;

          menuPopup.appendChild(menuItem);
          possibleAppMenuItems.push(menuItem);
        }
      }
    }

    // Create a menu item for the plugin.
    if (handlerInfo.pluginName) {
      var pluginMenuItem = document.createXULElement("menuitem");
      pluginMenuItem.setAttribute("action", kActionUsePlugin);
      let label = gMainPane._prefsBundle.getFormattedString("usePluginIn",
        [handlerInfo.pluginName,
        this._brandShortName]);
      pluginMenuItem.setAttribute("label", label);
      pluginMenuItem.setAttribute("tooltiptext", label);
      pluginMenuItem.setAttribute(APP_ICON_ATTR_NAME, "plugin");
      menuPopup.appendChild(pluginMenuItem);
    }

    // Create a menu item for selecting a local application.
    let canOpenWithOtherApp = true;
    if (AppConstants.platform == "win") {
      // On Windows, selecting an application to open another application
      // would be meaningless so we special case executables.
      let executableType = Cc["@mozilla.org/mime;1"].getService(Ci.nsIMIMEService)
        .getTypeFromExtension("exe");
      canOpenWithOtherApp = handlerInfo.type != executableType;
    }
    if (canOpenWithOtherApp) {
      let menuItem = document.createXULElement("menuitem");
      menuItem.className = "choose-app-item";
      menuItem.addEventListener("command", function(e) {
        gMainPane.chooseApp(e);
      });
      let label = gMainPane._prefsBundle.getString("useOtherApp");
      menuItem.setAttribute("label", label);
      menuItem.setAttribute("tooltiptext", label);
      menuPopup.appendChild(menuItem);
    }

    // Create a menu item for managing applications.
    if (possibleAppMenuItems.length) {
      let menuItem = document.createXULElement("menuseparator");
      menuPopup.appendChild(menuItem);
      menuItem = document.createXULElement("menuitem");
      menuItem.className = "manage-app-item";
      menuItem.addEventListener("command", function(e) {
        gMainPane.manageApp(e);
      });
      menuItem.setAttribute("label", gMainPane._prefsBundle.getString("manageApp"));
      menuPopup.appendChild(menuItem);
    }

    // Select the item corresponding to the preferred action.  If the always
    // ask flag is set, it overrides the preferred action.  Otherwise we pick
    // the item identified by the preferred action (when the preferred action
    // is to use a helper app, we have to pick the specific helper app item).
    if (handlerInfo.alwaysAskBeforeHandling)
      menu.selectedItem = askMenuItem;
    else switch (handlerInfo.preferredAction) {
      case Ci.nsIHandlerInfo.handleInternally:
        if (internalMenuItem) {
          menu.selectedItem = internalMenuItem;
        } else {
          Cu.reportError("No menu item defined to set!");
        }
        break;
      case Ci.nsIHandlerInfo.useSystemDefault:
        menu.selectedItem = defaultMenuItem;
        break;
      case Ci.nsIHandlerInfo.useHelperApp:
        if (preferredApp)
          menu.selectedItem =
            possibleAppMenuItems.filter(v => v.handlerApp.equals(preferredApp))[0];
        break;
      case kActionUsePlugin:
        menu.selectedItem = pluginMenuItem;
        break;
      case Ci.nsIHandlerInfo.saveToDisk:
        menu.selectedItem = saveMenuItem;
        break;
    }
  },


  // Sorting & Filtering

  _sortColumn: null,

  /**
   * Sort the list when the user clicks on a column header.
   */
  sort(event) {
    var column = event.target;

    // If the user clicked on a new sort column, remove the direction indicator
    // from the old column.
    if (this._sortColumn && this._sortColumn != column)
      this._sortColumn.removeAttribute("sortDirection");

    this._sortColumn = column;

    // Set (or switch) the sort direction indicator.
    if (column.getAttribute("sortDirection") == "ascending")
      column.setAttribute("sortDirection", "descending");
    else
      column.setAttribute("sortDirection", "ascending");

    this._sortVisibleTypes();
    this._rebuildView();
  },

  /**
   * Sort the list of visible types by the current sort column/direction.
   */
  _sortVisibleTypes() {
    if (!this._sortColumn)
      return;

    function sortByType(a, b) {
      return a.typeDescription.toLowerCase().
        localeCompare(b.typeDescription.toLowerCase());
    }

    function sortByAction(a, b) {
      return a.actionDescription.toLowerCase().
        localeCompare(b.actionDescription.toLowerCase());
    }

    switch (this._sortColumn.getAttribute("value")) {
      case "type":
        this._visibleTypes.sort(sortByType);
        break;
      case "action":
        this._visibleTypes.sort(sortByAction);
        break;
    }

    if (this._sortColumn.getAttribute("sortDirection") == "descending")
      this._visibleTypes.reverse();
  },

  /**
   * Filter the list when the user enters a filter term into the filter field.
   */
  filter() {
    this._rebuildView();
  },

  focusFilterBox() {
    this._filter.focus();
    this._filter.select();
  },


  // Changes

  // Whether or not we are currently storing the action selected by the user.
  // We use this to suppress notification-triggered updates to the list when
  // we make changes that may spawn such updates, specifically when we change
  // the action for the feed type, which results in feed preference updates,
  // which spawn "pref changed" notifications that would otherwise cause us
  // to rebuild the view unnecessarily.
  _storingAction: false,

  onSelectAction(aActionItem) {
    this._storingAction = true;

    try {
      this._storeAction(aActionItem);
    } finally {
      this._storingAction = false;
    }
  },

  _storeAction(aActionItem) {
    var handlerInfo = this.selectedHandlerListItem.handlerInfoWrapper;

    let action = parseInt(aActionItem.getAttribute("action"));

    // Set the plugin state if we're enabling or disabling a plugin.
    if (action == kActionUsePlugin)
      handlerInfo.enablePluginType();
    else if (handlerInfo.pluginName && !handlerInfo.isDisabledPluginType)
      handlerInfo.disablePluginType();

    // Set the preferred application handler.
    // We leave the existing preferred app in the list when we set
    // the preferred action to something other than useHelperApp so that
    // legacy datastores that don't have the preferred app in the list
    // of possible apps still include the preferred app in the list of apps
    // the user can choose to handle the type.
    if (action == Ci.nsIHandlerInfo.useHelperApp)
      handlerInfo.preferredApplicationHandler = aActionItem.handlerApp;

    // Set the "always ask" flag.
    if (action == Ci.nsIHandlerInfo.alwaysAsk)
      handlerInfo.alwaysAskBeforeHandling = true;
    else
      handlerInfo.alwaysAskBeforeHandling = false;

    // Set the preferred action.
    handlerInfo.preferredAction = action;

    handlerInfo.store();

    // Make sure the handler info object is flagged to indicate that there is
    // now some user configuration for the type.
    handlerInfo.handledOnlyByPlugin = false;

    // Update the action label and image to reflect the new preferred action.
    this.selectedHandlerListItem.refreshAction();
  },

  manageApp(aEvent) {
    // Don't let the normal "on select action" handler get this event,
    // as we handle it specially ourselves.
    aEvent.stopPropagation();

    var handlerInfo = this.selectedHandlerListItem.handlerInfoWrapper;

    let onComplete = () => {
      // Rebuild the actions menu so that we revert to the previous selection,
      // or "Always ask" if the previous default application has been removed
      this.rebuildActionsMenu();

      // update the richlistitem too. Will be visible when selecting another row
      this.selectedHandlerListItem.refreshAction();
    };

    gSubDialog.open("chrome://browser/content/preferences/applicationManager.xul",
      "resizable=no", handlerInfo, onComplete);

  },

  chooseApp(aEvent) {
    // Don't let the normal "on select action" handler get this event,
    // as we handle it specially ourselves.
    aEvent.stopPropagation();

    var handlerApp;
    let chooseAppCallback = aHandlerApp => {
      // Rebuild the actions menu whether the user picked an app or canceled.
      // If they picked an app, we want to add the app to the menu and select it.
      // If they canceled, we want to go back to their previous selection.
      this.rebuildActionsMenu();

      // If the user picked a new app from the menu, select it.
      if (aHandlerApp) {
        let typeItem = this._list.selectedItem;
        let actionsMenu = typeItem.querySelector(".actionsMenu");
        let menuItems = actionsMenu.menupopup.childNodes;
        for (let i = 0; i < menuItems.length; i++) {
          let menuItem = menuItems[i];
          if (menuItem.handlerApp && menuItem.handlerApp.equals(aHandlerApp)) {
            actionsMenu.selectedIndex = i;
            this.onSelectAction(menuItem);
            break;
          }
        }
      }
    };

    if (AppConstants.platform == "win") {
      var params = {};
      var handlerInfo = this.selectedHandlerListItem.handlerInfoWrapper;

      if (isFeedType(handlerInfo.type)) {
        // MIME info will be null, create a temp object.
        params.mimeInfo = gMIMEService.getFromTypeAndExtension(handlerInfo.type,
          handlerInfo.primaryExtension);
      } else {
        params.mimeInfo = handlerInfo.wrappedHandlerInfo;
      }

      params.title = gMainPane._prefsBundle.getString("fpTitleChooseApp");
      params.description = handlerInfo.description;
      params.filename = null;
      params.handlerApp = null;

      let onAppSelected = () => {
        if (this.isValidHandlerApp(params.handlerApp)) {
          handlerApp = params.handlerApp;

          // Add the app to the type's list of possible handlers.
          handlerInfo.addPossibleApplicationHandler(handlerApp);
        }

        chooseAppCallback(handlerApp);
      };

      gSubDialog.open("chrome://global/content/appPicker.xul",
        null, params, onAppSelected);
    } else {
      let winTitle = gMainPane._prefsBundle.getString("fpTitleChooseApp");
      let fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      let fpCallback = aResult => {
        if (aResult == Ci.nsIFilePicker.returnOK && fp.file &&
          this._isValidHandlerExecutable(fp.file)) {
          handlerApp = Cc["@mozilla.org/uriloader/local-handler-app;1"].
            createInstance(Ci.nsILocalHandlerApp);
          handlerApp.name = getFileDisplayName(fp.file);
          handlerApp.executable = fp.file;

          // Add the app to the type's list of possible handlers.
          let handler = this.selectedHandlerListItem.handlerInfoWrapper;
          handler.addPossibleApplicationHandler(handlerApp);

          chooseAppCallback(handlerApp);
        }
      };

      // Prompt the user to pick an app.  If they pick one, and it's a valid
      // selection, then add it to the list of possible handlers.
      fp.init(window, winTitle, Ci.nsIFilePicker.modeOpen);
      fp.appendFilters(Ci.nsIFilePicker.filterApps);
      fp.open(fpCallback);
    }
  },

  _getIconURLForHandlerApp(aHandlerApp) {
    if (aHandlerApp instanceof Ci.nsILocalHandlerApp)
      return this._getIconURLForFile(aHandlerApp.executable);

    if (aHandlerApp instanceof Ci.nsIWebHandlerApp)
      return this._getIconURLForWebApp(aHandlerApp.uriTemplate);

    // We know nothing about other kinds of handler apps.
    return "";
  },

  _getIconURLForFile(aFile) {
    var fph = Services.io.getProtocolHandler("file").
      QueryInterface(Ci.nsIFileProtocolHandler);
    var urlSpec = fph.getURLSpecFromFile(aFile);

    return "moz-icon://" + urlSpec + "?size=16";
  },

  _getIconURLForWebApp(aWebAppURITemplate) {
    var uri = Services.io.newURI(aWebAppURITemplate);

    // Unfortunately we can't use the favicon service to get the favicon,
    // because the service looks in the annotations table for a record with
    // the exact URL we give it, and users won't have such records for URLs
    // they don't visit, and users won't visit the web app's URL template,
    // they'll only visit URLs derived from that template (i.e. with %s
    // in the template replaced by the URL of the content being handled).

    if (/^https?$/.test(uri.scheme) && Services.prefs.getBoolPref("browser.chrome.site_icons"))
      return uri.prePath + "/favicon.ico";

    return "";
  },

  // DOWNLOADS

  /*
   * Preferences:
   *
   * browser.download.useDownloadDir - bool
   *   True - Save files directly to the folder configured via the
   *   browser.download.folderList preference.
   *   False - Always ask the user where to save a file and default to
   *   browser.download.lastDir when displaying a folder picker dialog.
   * browser.download.dir - local file handle
   *   A local folder the user may have selected for downloaded files to be
   *   saved. Migration of other browser settings may also set this path.
   *   This folder is enabled when folderList equals 2.
   * browser.download.lastDir - local file handle
   *   May contain the last folder path accessed when the user browsed
   *   via the file save-as dialog. (see contentAreaUtils.js)
   * browser.download.folderList - int
   *   Indicates the location users wish to save downloaded files too.
   *   It is also used to display special file labels when the default
   *   download location is either the Desktop or the Downloads folder.
   *   Values:
   *     0 - The desktop is the default download location.
   *     1 - The system's downloads folder is the default download location.
   *     2 - The default download location is elsewhere as specified in
   *         browser.download.dir.
   *     3 - The default download location is elsewhere as specified by
   *         cloud storage API getDownloadFolder
   * browser.download.downloadDir
   *   deprecated.
   * browser.download.defaultFolder
   *   deprecated.
   */

  /**
   * Enables/disables the folder field and Browse button based on whether a
   * default download directory is being used.
   */
  readUseDownloadDir() {
    var downloadFolder = document.getElementById("downloadFolder");
    var chooseFolder = document.getElementById("chooseFolder");
    var preference = Preferences.get("browser.download.useDownloadDir");
    downloadFolder.disabled = !preference.value || preference.locked;
    chooseFolder.disabled = !preference.value || preference.locked;

    this.readCloudStorage().catch(Cu.reportError);
    // don't override the preference's value in UI
    return undefined;
  },

  /**
   * Show/Hide the cloud storage radio button with provider name as label if
   * cloud storage provider is in use.
   * Select cloud storage radio button if browser.download.useDownloadDir is true
   * and browser.download.folderList has value 3. Enables/disables the folder field
   * and Browse button if cloud storage radio button is selected.
   *
   */
  async readCloudStorage() {
    // Get preferred provider in use display name
    let providerDisplayName = await CloudStorage.getProviderIfInUse();
    if (providerDisplayName) {
      // Show cloud storage radio button with provider name in label
      let saveToCloudRadio = document.getElementById("saveToCloud");
      let cloudStrings = Services.strings.createBundle("resource://cloudstorage/preferences.properties");
      saveToCloudRadio.label = cloudStrings.formatStringFromName("saveFilesToCloudStorage",
        [providerDisplayName], 1);
      saveToCloudRadio.hidden = false;

      let useDownloadDirPref = Preferences.get("browser.download.useDownloadDir");
      let folderListPref = Preferences.get("browser.download.folderList");

      // Check if useDownloadDir is true and folderListPref is set to Cloud Storage value 3
      // before selecting cloudStorageradio button. Disable folder field and Browse button if
      // 'Save to Cloud Storage Provider' radio option is selected
      if (useDownloadDirPref.value && folderListPref.value === 3) {
        document.getElementById("saveWhere").selectedItem = saveToCloudRadio;
        document.getElementById("downloadFolder").disabled = true;
        document.getElementById("chooseFolder").disabled = true;
      }
    }
  },

  /**
   * Handle clicks to 'Save To <custom path> or <system default downloads>' and
   * 'Save to <cloud storage provider>' if cloud storage radio button is displayed in UI.
   * Sets browser.download.folderList value and Enables/disables the folder field and Browse
   * button based on option selected.
   */
  handleSaveToCommand(event) {
    return this.handleSaveToCommandTask(event).catch(Cu.reportError);
  },
  async handleSaveToCommandTask(event) {
    if (event.target.id !== "saveToCloud" && event.target.id !== "saveTo") {
      return;
    }
    // Check if Save To Cloud Storage Provider radio option is displayed in UI
    // before continuing.
    let saveToCloudRadio = document.getElementById("saveToCloud");
    if (!saveToCloudRadio.hidden) {
      // When switching between SaveTo and SaveToCloud radio button
      // with useDownloadDirPref value true, if selectedIndex is other than
      // SaveTo radio button disable downloadFolder filefield and chooseFolder button
      let saveWhere = document.getElementById("saveWhere");
      let useDownloadDirPref = Preferences.get("browser.download.useDownloadDir");
      if (useDownloadDirPref.value) {
        let downloadFolder = document.getElementById("downloadFolder");
        let chooseFolder = document.getElementById("chooseFolder");
        downloadFolder.disabled = saveWhere.selectedIndex || useDownloadDirPref.locked;
        chooseFolder.disabled = saveWhere.selectedIndex || useDownloadDirPref.locked;
      }

      // Set folderListPref value depending on radio option
      // selected. folderListPref should be set to 3 if Save To Cloud Storage Provider
      // option is selected. If user switch back to 'Save To' custom path or system
      // default Downloads, check pref 'browser.download.dir' before setting respective
      // folderListPref value. If currentDirPref is unspecified folderList should
      // default to 1
      let folderListPref = Preferences.get("browser.download.folderList");
      let saveTo = document.getElementById("saveTo");
      if (saveWhere.selectedItem == saveToCloudRadio) {
        folderListPref.value = 3;
      } else if (saveWhere.selectedItem == saveTo) {
        let currentDirPref = Preferences.get("browser.download.dir");
        folderListPref.value = currentDirPref.value ? await this._folderToIndex(currentDirPref.value) : 1;
      }
    }
  },

  /**
   * Displays a file picker in which the user can choose the location where
   * downloads are automatically saved, updating preferences and UI in
   * response to the choice, if one is made.
   */
  chooseFolder() {
    return this.chooseFolderTask().catch(Cu.reportError);
  },
  async chooseFolderTask() {
    let title = gMainPane._prefsBundle.getString("chooseDownloadFolderTitle");
    let folderListPref = Preferences.get("browser.download.folderList");
    let currentDirPref = await this._indexToFolder(folderListPref.value);
    let defDownloads = await this._indexToFolder(1);
    let fp = Cc["@mozilla.org/filepicker;1"].
      createInstance(Ci.nsIFilePicker);

    fp.init(window, title, Ci.nsIFilePicker.modeGetFolder);
    fp.appendFilters(Ci.nsIFilePicker.filterAll);
    // First try to open what's currently configured
    if (currentDirPref && currentDirPref.exists()) {
      fp.displayDirectory = currentDirPref;
    } else if (defDownloads && defDownloads.exists()) {
      // Try the system's download dir
      fp.displayDirectory = defDownloads;
    } else {
      // Fall back to Desktop
      fp.displayDirectory = await this._indexToFolder(0);
    }

    let result = await new Promise(resolve => fp.open(resolve));
    if (result != Ci.nsIFilePicker.returnOK) {
      return;
    }

    let downloadDirPref = Preferences.get("browser.download.dir");
    downloadDirPref.value = fp.file;
    folderListPref.value = await this._folderToIndex(fp.file);
    // Note, the real prefs will not be updated yet, so dnld manager's
    // userDownloadsDirectory may not return the right folder after
    // this code executes. displayDownloadDirPref will be called on
    // the assignment above to update the UI.
  },

  /**
   * Initializes the download folder display settings based on the user's
   * preferences.
   */
  displayDownloadDirPref() {
    this.displayDownloadDirPrefTask().catch(Cu.reportError);

    // don't override the preference's value in UI
    return undefined;
  },

  async displayDownloadDirPrefTask() {
    var folderListPref = Preferences.get("browser.download.folderList");
    var downloadFolder = document.getElementById("downloadFolder");
    var currentDirPref = Preferences.get("browser.download.dir");

    // Used in defining the correct path to the folder icon.
    var fph = Services.io.getProtocolHandler("file")
      .QueryInterface(Ci.nsIFileProtocolHandler);
    var iconUrlSpec;

    let folderIndex = folderListPref.value;
    if (folderIndex == 3) {
      // When user has selected cloud storage, use value in currentDirPref to
      // compute index to display download folder label and icon to avoid
      // displaying blank downloadFolder label and icon on load of preferences UI
      // Set folderIndex to 1 if currentDirPref is unspecified
      folderIndex = currentDirPref.value ? await this._folderToIndex(currentDirPref.value) : 1;
    }

    // Display a 'pretty' label or the path in the UI.
    if (folderIndex == 2) {
      // Force the left-to-right direction when displaying a custom path.
      downloadFolder.value = currentDirPref.value ?
        `\u2066${currentDirPref.value.path}\u2069` : "";
      iconUrlSpec = fph.getURLSpecFromFile(currentDirPref.value);
    } else if (folderIndex == 1) {
      // 'Downloads'
      downloadFolder.value = gMainPane._prefsBundle.getString("downloadsFolderName");
      iconUrlSpec = fph.getURLSpecFromFile(await this._indexToFolder(1));
    } else {
      // 'Desktop'
      downloadFolder.value = gMainPane._prefsBundle.getString("desktopFolderName");
      iconUrlSpec = fph.getURLSpecFromFile(await this._getDownloadsFolder("Desktop"));
    }
    downloadFolder.style.backgroundImage = "url(moz-icon://" + iconUrlSpec + "?size=16)";
  },

  /**
   * Returns the Downloads folder.  If aFolder is "Desktop", then the Downloads
   * folder returned is the desktop folder; otherwise, it is a folder whose name
   * indicates that it is a download folder and whose path is as determined by
   * the XPCOM directory service via the download manager's attribute
   * defaultDownloadsDirectory.
   *
   * @throws if aFolder is not "Desktop" or "Downloads"
   */
  async _getDownloadsFolder(aFolder) {
    switch (aFolder) {
      case "Desktop":
        return Services.dirsvc.get("Desk", Ci.nsIFile);
      case "Downloads":
        let downloadsDir = await Downloads.getSystemDownloadsDirectory();
        return new FileUtils.File(downloadsDir);
    }
    throw "ASSERTION FAILED: folder type should be 'Desktop' or 'Downloads'";
  },

  /**
   * Determines the type of the given folder.
   *
   * @param   aFolder
   *          the folder whose type is to be determined
   * @returns integer
   *          0 if aFolder is the Desktop or is unspecified,
   *          1 if aFolder is the Downloads folder,
   *          2 otherwise
   */
  async _folderToIndex(aFolder) {
    if (!aFolder || aFolder.equals(await this._getDownloadsFolder("Desktop")))
      return 0;
    else if (aFolder.equals(await this._getDownloadsFolder("Downloads")))
      return 1;
    return 2;
  },

  /**
   * Converts an integer into the corresponding folder.
   *
   * @param   aIndex
   *          an integer
   * @returns the Desktop folder if aIndex == 0,
   *          the Downloads folder if aIndex == 1,
   *          the folder stored in browser.download.dir
   */
  _indexToFolder(aIndex) {
    switch (aIndex) {
      case 0:
        return this._getDownloadsFolder("Desktop");
      case 1:
        return this._getDownloadsFolder("Downloads");
    }
    var currentDirPref = Preferences.get("browser.download.dir");
    return currentDirPref.value;
  }
};

// Utilities

function getFileDisplayName(file) {
  if (AppConstants.platform == "win") {
    if (file instanceof Ci.nsILocalFileWin) {
      try {
        return file.getVersionInfoField("FileDescription");
      } catch (e) { }
    }
  }
  if (AppConstants.platform == "macosx") {
    if (file instanceof Ci.nsILocalFileMac) {
      try {
        return file.bundleDisplayName;
      } catch (e) { }
    }
  }
  return file.leafName;
}

function getLocalHandlerApp(aFile) {
  var localHandlerApp = Cc["@mozilla.org/uriloader/local-handler-app;1"].
    createInstance(Ci.nsILocalHandlerApp);
  localHandlerApp.name = getFileDisplayName(aFile);
  localHandlerApp.executable = aFile;

  return localHandlerApp;
}

/**
 * An enumeration of items in a JS array.
 *
 * FIXME: use ArrayConverter once it lands (bug 380839).
 *
 * @constructor
 */
function ArrayEnumerator(aItems) {
  this._index = 0;
  this._contents = aItems;
}

ArrayEnumerator.prototype = {
  _index: 0,

  [Symbol.iterator]() {
    return this._contents.values();
  },

  hasMoreElements() {
    return this._index < this._contents.length;
  },

  getNext() {
    return this._contents[this._index++];
  }
};

function isFeedType(t) {
  return t == TYPE_MAYBE_FEED || t == TYPE_MAYBE_VIDEO_FEED || t == TYPE_MAYBE_AUDIO_FEED;
}

// eslint-disable-next-line no-undef
let gHandlerListItemFragment = MozXULElement.parseXULToFragment(`
  <richlistitem>
    <hbox flex="1" equalsize="always">
      <hbox class="typeContainer" flex="1" align="center">
        <image class="typeIcon" width="16" height="16"
               src="moz-icon://goat?size=16"/>
        <label class="typeDescription" flex="1" crop="end"/>
      </hbox>
      <hbox class="actionContainer" flex="1" align="center">
        <image class="actionIcon" width="16" height="16"/>
        <label class="actionDescription" flex="1" crop="end"/>
      </hbox>
      <hbox class="actionsMenuContainer" flex="1">
        <menulist class="actionsMenu" flex="1" crop="end" selectedIndex="1">
          <menupopup/>
        </menulist>
      </hbox>
    </hbox>
  </richlistitem>
`);

/**
 * This is associated to <richlistitem> elements in the handlers view.
 */
class HandlerListItem {
  static forNode(node) {
    return gNodeToObjectMap.get(node);
  }

  constructor(handlerInfoWrapper) {
    this.handlerInfoWrapper = handlerInfoWrapper;
  }

  setOrRemoveAttributes(iterable) {
    for (let [selector, name, value] of iterable) {
      let node = selector ? this.node.querySelector(selector) : this.node;
      if (value) {
        node.setAttribute(name, value);
      } else {
        node.removeAttribute(name);
      }
    }
  }

  connectAndAppendToList(list) {
    list.appendChild(document.importNode(gHandlerListItemFragment, true));
    this.node = list.lastChild;
    gNodeToObjectMap.set(this.node, this);

    this.node.querySelector(".actionsMenu").addEventListener("command",
      event => gMainPane.onSelectAction(event.originalTarget));

    let typeDescription = this.handlerInfoWrapper.typeDescription;
    this.setOrRemoveAttributes([
      [null, "type", this.handlerInfoWrapper.type],
      [".typeContainer", "tooltiptext", typeDescription],
      [".typeDescription", "value", typeDescription],
      [".typeIcon", "src", this.handlerInfoWrapper.smallIcon],
    ]);
    this.refreshAction();
    this.showActionsMenu = false;
  }

  refreshAction() {
    let { actionIconClass, actionDescription } = this.handlerInfoWrapper;
    this.setOrRemoveAttributes([
      [null, APP_ICON_ATTR_NAME, actionIconClass],
      [".actionContainer", "tooltiptext", actionDescription],
      [".actionDescription", "value", actionDescription],
      [".actionIcon", "src", actionIconClass ? null :
                             this.handlerInfoWrapper.actionIcon],
    ]);
  }

  set showActionsMenu(value) {
    this.setOrRemoveAttributes([
      [".actionContainer", "hidden", value],
      [".actionsMenuContainer", "hidden", !value],
    ]);
  }
}

/**
 * This object wraps nsIHandlerInfo with some additional functionality
 * the Applications prefpane needs to display and allow modification of
 * the list of handled types.
 *
 * We create an instance of this wrapper for each entry we might display
 * in the prefpane, and we compose the instances from various sources,
 * including plugins and the handler service.
 *
 * We don't implement all the original nsIHandlerInfo functionality,
 * just the stuff that the prefpane needs.
 */
class HandlerInfoWrapper {
  constructor(type, handlerInfo) {
    this.type = type;
    this.wrappedHandlerInfo = handlerInfo;
    this.disambiguateDescription = false;

    // A plugin that can handle this type, if any.
    //
    // Note: just because we have one doesn't mean it *will* handle the type.
    // That depends on whether or not the type is in the list of types for which
    // plugin handling is disabled.
    this.pluginName = "";

    // Whether or not this type is only handled by a plugin or is also handled
    // by some user-configured action as specified in the handler info object.
    //
    // Note: we can't just check if there's a handler info object for this type,
    // because OS and user configuration is mixed up in the handler info object,
    // so we always need to retrieve it for the OS info and can't tell whether
    // it represents only OS-default information or user-configured information.
    //
    // FIXME: once handler info records are broken up into OS-provided records
    // and user-configured records, stop using this boolean flag and simply
    // check for the presence of a user-configured record to determine whether
    // or not this type is only handled by a plugin.  Filed as bug 395142.
    this.handledOnlyByPlugin = false;
  }

  get description() {
    if (this.wrappedHandlerInfo.description)
      return this.wrappedHandlerInfo.description;

    if (this.primaryExtension) {
      var extension = this.primaryExtension.toUpperCase();
      return gMainPane._prefsBundle.getFormattedString("fileEnding",
        [extension]);
    }

    return this.type;
  }

  /**
   * Describe, in a human-readable fashion, the type represented by the given
   * handler info object.  Normally this is just the description, but if more
   * than one object presents the same description, "disambiguateDescription"
   * is set and we annotate the duplicate descriptions with the type itself
   * to help users distinguish between those types.
   */
  get typeDescription() {
    if (this.disambiguateDescription) {
      return gMainPane._prefsBundle.getFormattedString(
        "typeDescriptionWithType", [this.description, this.type]);
    }

    return this.description;
  }

  /**
   * Describe, in a human-readable fashion, the preferred action to take on
   * the type represented by the given handler info object.
   */
  get actionDescription() {
    // alwaysAskBeforeHandling overrides the preferred action, so if that flag
    // is set, then describe that behavior instead.  For most types, this is
    // the "alwaysAsk" string, but for the feed type we show something special.
    if (this.alwaysAskBeforeHandling) {
      if (isFeedType(this.type))
        return gMainPane._prefsBundle.getFormattedString("previewInApp",
          [gMainPane._brandShortName]);
      return gMainPane._prefsBundle.getString("alwaysAsk");
    }

    switch (this.preferredAction) {
      case Ci.nsIHandlerInfo.saveToDisk:
        return gMainPane._prefsBundle.getString("saveFile");

      case Ci.nsIHandlerInfo.useHelperApp:
        var preferredApp = this.preferredApplicationHandler;
        var name;
        if (preferredApp instanceof Ci.nsILocalHandlerApp)
          name = getFileDisplayName(preferredApp.executable);
        else
          name = preferredApp.name;
        return gMainPane._prefsBundle.getFormattedString("useApp", [name]);

      case Ci.nsIHandlerInfo.handleInternally:
        // For the feed type, handleInternally means live bookmarks.
        if (isFeedType(this.type)) {
          return gMainPane._prefsBundle.getFormattedString("addLiveBookmarksInApp",
            [gMainPane._brandShortName]);
        }

        if (this instanceof InternalHandlerInfoWrapper) {
          return gMainPane._prefsBundle.getFormattedString("previewInApp",
            [gMainPane._brandShortName]);
        }

        // For other types, handleInternally looks like either useHelperApp
        // or useSystemDefault depending on whether or not there's a preferred
        // handler app.
        if (gMainPane.isValidHandlerApp(this.preferredApplicationHandler))
          return this.preferredApplicationHandler.name;

        return this.defaultDescription;

      // XXX Why don't we say the app will handle the type internally?
      // Is it because the app can't actually do that?  But if that's true,
      // then why would a preferredAction ever get set to this value
      // in the first place?

      case Ci.nsIHandlerInfo.useSystemDefault:
        return gMainPane._prefsBundle.getFormattedString("useDefault",
          [this.defaultDescription]);

      case kActionUsePlugin:
        return gMainPane._prefsBundle.getFormattedString("usePluginIn",
          [this.pluginName,
          gMainPane._brandShortName]);
      default:
        throw new Error(`Unexpected preferredAction: ${this.preferredAction}`);
    }
  }

  get actionIconClass() {
    if (this.alwaysAskBeforeHandling) {
      return "ask";
    }

    switch (this.preferredAction) {
      case Ci.nsIHandlerInfo.saveToDisk:
        return "save";

      case Ci.nsIHandlerInfo.handleInternally:
        if (isFeedType(this.type)) {
          return "feed";
        } else if (this instanceof InternalHandlerInfoWrapper) {
          return "ask";
        }

      case kActionUsePlugin:
        return "plugin";
    }

    return "";
  }

  get actionIcon() {
    switch (this.preferredAction) {
      case Ci.nsIHandlerInfo.useSystemDefault:
        return this.iconURLForSystemDefault;

      case Ci.nsIHandlerInfo.useHelperApp:
        let preferredApp = this.preferredApplicationHandler;
        if (gMainPane.isValidHandlerApp(preferredApp)) {
          return gMainPane._getIconURLForHandlerApp(preferredApp);
        }
      // Explicit fall-through

      // This should never happen, but if preferredAction is set to some weird
      // value, then fall back to the generic application icon.
      default:
        return ICON_URL_APP;
    }
  }

  get iconURLForSystemDefault() {
    // Handler info objects for MIME types on some OSes implement a property bag
    // interface from which we can get an icon for the default app, so if we're
    // dealing with a MIME type on one of those OSes, then try to get the icon.
    if (this.wrappedHandlerInfo instanceof Ci.nsIMIMEInfo &&
        this.wrappedHandlerInfo instanceof Ci.nsIPropertyBag) {
      try {
        let url = this.wrappedHandlerInfo.getProperty("defaultApplicationIconURL");
        if (url) {
          return url + "?size=16";
        }
      } catch (ex) { }
    }

    // If this isn't a MIME type object on an OS that supports retrieving
    // the icon, or if we couldn't retrieve the icon for some other reason,
    // then use a generic icon.
    return ICON_URL_APP;
  }

  get preferredApplicationHandler() {
    return this.wrappedHandlerInfo.preferredApplicationHandler;
  }

  set preferredApplicationHandler(aNewValue) {
    this.wrappedHandlerInfo.preferredApplicationHandler = aNewValue;

    // Make sure the preferred handler is in the set of possible handlers.
    if (aNewValue)
      this.addPossibleApplicationHandler(aNewValue);
  }

  get possibleApplicationHandlers() {
    return this.wrappedHandlerInfo.possibleApplicationHandlers;
  }

  addPossibleApplicationHandler(aNewHandler) {
    for (let app of this.possibleApplicationHandlers.enumerate()) {
      if (app.equals(aNewHandler))
        return;
    }
    this.possibleApplicationHandlers.appendElement(aNewHandler);
  }

  removePossibleApplicationHandler(aHandler) {
    var defaultApp = this.preferredApplicationHandler;
    if (defaultApp && aHandler.equals(defaultApp)) {
      // If the app we remove was the default app, we must make sure
      // it won't be used anymore
      this.alwaysAskBeforeHandling = true;
      this.preferredApplicationHandler = null;
    }

    var handlers = this.possibleApplicationHandlers;
    for (var i = 0; i < handlers.length; ++i) {
      var handler = handlers.queryElementAt(i, Ci.nsIHandlerApp);
      if (handler.equals(aHandler)) {
        handlers.removeElementAt(i);
        break;
      }
    }
  }

  get hasDefaultHandler() {
    return this.wrappedHandlerInfo.hasDefaultHandler;
  }

  get defaultDescription() {
    return this.wrappedHandlerInfo.defaultDescription;
  }

  // What to do with content of this type.
  get preferredAction() {
    // If we have an enabled plugin, then the action is to use that plugin.
    if (this.pluginName && !this.isDisabledPluginType)
      return kActionUsePlugin;

    // If the action is to use a helper app, but we don't have a preferred
    // handler app, then switch to using the system default, if any; otherwise
    // fall back to saving to disk, which is the default action in nsMIMEInfo.
    // Note: "save to disk" is an invalid value for protocol info objects,
    // but the alwaysAskBeforeHandling getter will detect that situation
    // and always return true in that case to override this invalid value.
    if (this.wrappedHandlerInfo.preferredAction == Ci.nsIHandlerInfo.useHelperApp &&
      !gMainPane.isValidHandlerApp(this.preferredApplicationHandler)) {
      if (this.wrappedHandlerInfo.hasDefaultHandler)
        return Ci.nsIHandlerInfo.useSystemDefault;
      return Ci.nsIHandlerInfo.saveToDisk;
    }

    return this.wrappedHandlerInfo.preferredAction;
  }

  set preferredAction(aNewValue) {
    // If the action is to use the plugin,
    // we must set the preferred action to "save to disk".
    // But only if it's not currently the preferred action.
    if ((aNewValue == kActionUsePlugin) &&
      (this.preferredAction != Ci.nsIHandlerInfo.saveToDisk)) {
      aNewValue = Ci.nsIHandlerInfo.saveToDisk;
    }

    // We don't modify the preferred action if the new action is to use a plugin
    // because handler info objects don't understand our custom "use plugin"
    // value.  Also, leaving it untouched means that we can automatically revert
    // to the old setting if the user ever removes the plugin.

    if (aNewValue != kActionUsePlugin)
      this.wrappedHandlerInfo.preferredAction = aNewValue;
  }

  get alwaysAskBeforeHandling() {
    // If this type is handled only by a plugin, we can't trust the value
    // in the handler info object, since it'll be a default based on the absence
    // of any user configuration, and the default in that case is to always ask,
    // even though we never ask for content handled by a plugin, so special case
    // plugin-handled types by returning false here.
    if (this.pluginName && this.handledOnlyByPlugin)
      return false;

    // If this is a protocol type and the preferred action is "save to disk",
    // which is invalid for such types, then return true here to override that
    // action.  This could happen when the preferred action is to use a helper
    // app, but the preferredApplicationHandler is invalid, and there isn't
    // a default handler, so the preferredAction getter returns save to disk
    // instead.
    if (!(this.wrappedHandlerInfo instanceof Ci.nsIMIMEInfo) &&
      this.preferredAction == Ci.nsIHandlerInfo.saveToDisk)
      return true;

    return this.wrappedHandlerInfo.alwaysAskBeforeHandling;
  }

  set alwaysAskBeforeHandling(aNewValue) {
    this.wrappedHandlerInfo.alwaysAskBeforeHandling = aNewValue;
  }

  // The primary file extension associated with this type, if any.
  //
  // XXX Plugin objects contain an array of MimeType objects with "suffixes"
  // properties; if this object has an associated plugin, shouldn't we check
  // those properties for an extension?
  get primaryExtension() {
    try {
      if (this.wrappedHandlerInfo instanceof Ci.nsIMIMEInfo &&
        this.wrappedHandlerInfo.primaryExtension)
        return this.wrappedHandlerInfo.primaryExtension;
    } catch (ex) { }

    return null;
  }

  get isDisabledPluginType() {
    return this._getDisabledPluginTypes().includes(this.type);
  }

  _getDisabledPluginTypes() {
    var types = "";

    if (Services.prefs.prefHasUserValue(PREF_DISABLED_PLUGIN_TYPES))
      types = Services.prefs.getCharPref(PREF_DISABLED_PLUGIN_TYPES);

    // Only split if the string isn't empty so we don't end up with an array
    // containing a single empty string.
    if (types != "")
      return types.split(",");

    return [];
  }

  disablePluginType() {
    var disabledPluginTypes = this._getDisabledPluginTypes();

    if (!disabledPluginTypes.includes(this.type))
      disabledPluginTypes.push(this.type);

    Services.prefs.setCharPref(PREF_DISABLED_PLUGIN_TYPES,
      disabledPluginTypes.join(","));

    // Update the category manager so existing browser windows update.
    gCategoryManager.deleteCategoryEntry("Gecko-Content-Viewers",
      this.type,
      false);
  }

  enablePluginType() {
    var disabledPluginTypes = this._getDisabledPluginTypes();

    var type = this.type;
    disabledPluginTypes = disabledPluginTypes.filter(v => v != type);

    Services.prefs.setCharPref(PREF_DISABLED_PLUGIN_TYPES,
      disabledPluginTypes.join(","));

    // Update the category manager so existing browser windows update.
    gCategoryManager.addCategoryEntry(
      "Gecko-Content-Viewers",
      this.type,
      "@mozilla.org/content/plugin/document-loader-factory;1",
      false,
      true);
  }

  store() {
    gHandlerService.store(this.wrappedHandlerInfo);
  }

  get smallIcon() {
    return this._getIcon(16);
  }

  _getIcon(aSize) {
    if (this.primaryExtension)
      return "moz-icon://goat." + this.primaryExtension + "?size=" + aSize;

    if (this.wrappedHandlerInfo instanceof Ci.nsIMIMEInfo)
      return "moz-icon://goat?size=" + aSize + "&contentType=" + this.type;

    // FIXME: consider returning some generic icon when we can't get a URL for
    // one (for example in the case of protocol schemes).  Filed as bug 395141.
    return null;
  }
}

/**
 * This object implements nsIHandlerInfo for the feed types.  It's a separate
 * object because we currently store handling information for the feed type
 * in a set of preferences rather than the nsIHandlerService-managed datastore.
 *
 * This object inherits from HandlerInfoWrapper in order to get functionality
 * that isn't special to the feed type.
 */
class FeedHandlerInfo extends HandlerInfoWrapper {
  constructor(aMIMEType, properties) {
    super(aMIMEType, null);
    Object.assign(this, properties);
  }

  get description() {
    return gMainPane._prefsBundle.getString(this._appPrefLabel);
  }

  get preferredApplicationHandler() {
    switch (Preferences.get(this._prefSelectedReader).value) {
      case "client":
        var file = Preferences.get(this._prefSelectedApp).value;
        if (file)
          return getLocalHandlerApp(file);

        return null;

      case "bookmarks":
      default:
        // When the pref is set to bookmarks, we handle feeds internally,
        // we don't forward them to a local or web handler app, so there is
        // no preferred handler.
        return null;
    }
  }

  set preferredApplicationHandler(aNewValue) {
    if (aNewValue instanceof Ci.nsILocalHandlerApp) {
      Preferences.get(this._prefSelectedApp).value = aNewValue.executable;
      Preferences.get(this._prefSelectedReader).value = "client";
    }
  }

  get possibleApplicationHandlers() {
    if (this._possibleApplicationHandlers)
      return this._possibleApplicationHandlers;

    // A minimal implementation of nsIMutableArray.  It only supports the two
    // methods its callers invoke, namely appendElement and nsIArray::enumerate.
    this._possibleApplicationHandlers = {
      _inner: [],
      _removed: [],

      QueryInterface: ChromeUtils.generateQI(["nsIMutableArray", "nsIArray"]),

      get length() {
        return this._inner.length;
      },

      enumerate() {
        return new ArrayEnumerator(this._inner);
      },

      appendElement(aHandlerApp, aWeak) {
        this._inner.push(aHandlerApp);
      },

      removeElementAt(aIndex) {
        this._removed.push(this._inner[aIndex]);
        this._inner.splice(aIndex, 1);
      },

      queryElementAt(aIndex, aInterface) {
        return this._inner[aIndex].QueryInterface(aInterface);
      }
    };

    // Add the selected local app if it's different from the OS default handler.
    // Unlike for other types, we can store only one local app at a time for the
    // feed type, since we store it in a preference that historically stores
    // only a single path.  But we display all the local apps the user chooses
    // while the prefpane is open, only dropping the list when the user closes
    // the prefpane, for maximum usability and consistency with other types.
    var preferredAppFile = Preferences.get(this._prefSelectedApp).value;
    if (preferredAppFile) {
      let preferredApp = getLocalHandlerApp(preferredAppFile);
      let defaultApp = this._defaultApplicationHandler;
      if (!defaultApp || !defaultApp.equals(preferredApp))
        this._possibleApplicationHandlers.appendElement(preferredApp);
    }

    return this._possibleApplicationHandlers;
  }

  get _defaultApplicationHandler() {
    if (typeof this.__defaultApplicationHandler != "undefined")
      return this.__defaultApplicationHandler;

    var defaultFeedReader = null;
    if (AppConstants.HAVE_SHELL_SERVICE) {
      try {
        defaultFeedReader = getShellService().defaultFeedReader;
      } catch (ex) {
        // no default reader or getShellService() is null
      }
    }

    if (defaultFeedReader) {
      let handlerApp = Cc["@mozilla.org/uriloader/local-handler-app;1"].
        createInstance(Ci.nsIHandlerApp);
      handlerApp.name = getFileDisplayName(defaultFeedReader);
      handlerApp.QueryInterface(Ci.nsILocalHandlerApp);
      handlerApp.executable = defaultFeedReader;

      this.__defaultApplicationHandler = handlerApp;
    } else {
      this.__defaultApplicationHandler = null;
    }

    return this.__defaultApplicationHandler;
  }

  get hasDefaultHandler() {
    if (AppConstants.HAVE_SHELL_SERVICE) {
      try {
        if (getShellService().defaultFeedReader)
          return true;
      } catch (ex) {
        // no default reader or getShellService() is null
      }
    }

    return false;
  }

  get defaultDescription() {
    if (this.hasDefaultHandler)
      return this._defaultApplicationHandler.name;

    // Should we instead return null?
    return "";
  }

  // What to do with content of this type.
  get preferredAction() {
    switch (Preferences.get(this._prefSelectedAction).value) {

      case "bookmarks":
        return Ci.nsIHandlerInfo.handleInternally;

      case "reader": {
        let preferredApp = this.preferredApplicationHandler;
        let defaultApp = this._defaultApplicationHandler;

        // If we have a valid preferred app, return useSystemDefault if it's
        // the default app; otherwise return useHelperApp.
        if (gMainPane.isValidHandlerApp(preferredApp)) {
          if (defaultApp && defaultApp.equals(preferredApp))
            return Ci.nsIHandlerInfo.useSystemDefault;

          return Ci.nsIHandlerInfo.useHelperApp;
        }

        // The pref is set to "reader", but we don't have a valid preferred app.
        // What do we do now?  Not sure this is the best option (perhaps we
        // should direct the user to the default app, if any), but for now let's
        // direct the user to live bookmarks.
        return Ci.nsIHandlerInfo.handleInternally;
      }

      // If the action is "ask", then alwaysAskBeforeHandling will override
      // the action, so it doesn't matter what we say it is, it just has to be
      // something that doesn't cause the controller to hide the type.
      case "ask":
      default:
        return Ci.nsIHandlerInfo.handleInternally;
    }
  }

  set preferredAction(aNewValue) {
    switch (aNewValue) {

      case Ci.nsIHandlerInfo.handleInternally:
        Preferences.get(this._prefSelectedReader).value = "bookmarks";
        break;

      case Ci.nsIHandlerInfo.useHelperApp:
        Preferences.get(this._prefSelectedAction).value = "reader";
        // The controller has already set preferredApplicationHandler
        // to the new helper app.
        break;

      case Ci.nsIHandlerInfo.useSystemDefault:
        Preferences.get(this._prefSelectedAction).value = "reader";
        this.preferredApplicationHandler = this._defaultApplicationHandler;
        break;
    }
  }

  get alwaysAskBeforeHandling() {
    return Preferences.get(this._prefSelectedAction).value == "ask";
  }

  set alwaysAskBeforeHandling(aNewValue) {
    if (aNewValue)
      Preferences.get(this._prefSelectedAction).value = "ask";
    else
      Preferences.get(this._prefSelectedAction).value = "reader";
  }

  get primaryExtension() {
    return "xml";
  }

  // Changes to the preferred action and handler take effect immediately
  // (we write them out to the preferences right as they happen),
  // so we when the controller calls store() after modifying the handlers,
  // the only thing we need to store is the removal of possible handlers
  // XXX Should we hold off on making the changes until this method gets called?
  store() {
    for (let app of this._possibleApplicationHandlers._removed) {
      if (app instanceof Ci.nsILocalHandlerApp) {
        let pref = Preferences.get(PREF_FEED_SELECTED_APP);
        var preferredAppFile = pref.value;
        if (preferredAppFile) {
          let preferredApp = getLocalHandlerApp(preferredAppFile);
          if (app.equals(preferredApp))
            pref.reset();
        }
      }
    }
    this._possibleApplicationHandlers._removed = [];
  }

  get smallIcon() {
    return this._smallIcon;
  }
}

var feedHandlerInfo = new FeedHandlerInfo(TYPE_MAYBE_FEED, {
  _prefSelectedApp: PREF_FEED_SELECTED_APP,
  _prefSelectedAction: PREF_FEED_SELECTED_ACTION,
  _prefSelectedReader: PREF_FEED_SELECTED_READER,
  _smallIcon: "chrome://browser/skin/feeds/feedIcon16.png",
  _appPrefLabel: "webFeed"
});

var videoFeedHandlerInfo = new FeedHandlerInfo(TYPE_MAYBE_VIDEO_FEED, {
  _prefSelectedApp: PREF_VIDEO_FEED_SELECTED_APP,
  _prefSelectedAction: PREF_VIDEO_FEED_SELECTED_ACTION,
  _prefSelectedReader: PREF_VIDEO_FEED_SELECTED_READER,
  _smallIcon: "chrome://browser/skin/feeds/videoFeedIcon16.png",
  _appPrefLabel: "videoPodcastFeed"
});

var audioFeedHandlerInfo = new FeedHandlerInfo(TYPE_MAYBE_AUDIO_FEED, {
  _prefSelectedApp: PREF_AUDIO_FEED_SELECTED_APP,
  _prefSelectedAction: PREF_AUDIO_FEED_SELECTED_ACTION,
  _prefSelectedReader: PREF_AUDIO_FEED_SELECTED_READER,
  _smallIcon: "chrome://browser/skin/feeds/audioFeedIcon16.png",
  _appPrefLabel: "audioPodcastFeed"
});

/**
 * InternalHandlerInfoWrapper provides a basic mechanism to create an internal
 * mime type handler that can be enabled/disabled in the applications preference
 * menu.
 */
class InternalHandlerInfoWrapper extends HandlerInfoWrapper {
  constructor(mimeType) {
    super(mimeType, gMIMEService.getFromTypeAndExtension(mimeType, null));
  }

  // Override store so we so we can notify any code listening for registration
  // or unregistration of this handler.
  store() {
    super.store();
    Services.obs.notifyObservers(null, this._handlerChanged);
  }

  get enabled() {
    throw Cr.NS_ERROR_NOT_IMPLEMENTED;
  }

  get description() {
    return gMainPane._prefsBundle.getString(this._appPrefLabel);
  }
}

class PDFHandlerInfoWrapper extends InternalHandlerInfoWrapper {
  constructor() {
    super(TYPE_PDF);
  }

  get _handlerChanged() {
    return TOPIC_PDFJS_HANDLER_CHANGED;
  }

  get _appPrefLabel() {
    return "portableDocumentFormat";
  }

  get enabled() {
    return !Services.prefs.getBoolPref(PREF_PDFJS_DISABLED) &&
           Services.policies.isAllowed("PDF.js");
  }
}
