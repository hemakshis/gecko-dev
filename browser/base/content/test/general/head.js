ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");

ChromeUtils.defineModuleGetter(this, "PlacesUtils",
  "resource://gre/modules/PlacesUtils.jsm");
ChromeUtils.defineModuleGetter(this, "PlacesTestUtils",
  "resource://testing-common/PlacesTestUtils.jsm");
ChromeUtils.defineModuleGetter(this, "BrowserTestUtils",
  "resource://testing-common/BrowserTestUtils.jsm");
ChromeUtils.defineModuleGetter(this, "TabCrashHandler",
  "resource:///modules/ContentCrashHandlers.jsm");

/**
 * Wait for a <notification> to be closed then call the specified callback.
 */
function waitForNotificationClose(notification, cb) {
  let parent = notification.parentNode;

  let observer = new MutationObserver(function onMutatations(mutations) {
    for (let mutation of mutations) {
      for (let i = 0; i < mutation.removedNodes.length; i++) {
        let node = mutation.removedNodes.item(i);
        if (node != notification) {
          continue;
        }
        observer.disconnect();
        cb();
      }
    }
  });
  observer.observe(parent, {childList: true});
}

function closeAllNotifications() {
  let notificationBox = document.getElementById("global-notificationbox");

  if (!notificationBox || !notificationBox.currentNotification) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    for (let notification of notificationBox.allNotifications) {
      waitForNotificationClose(notification, function() {
        if (notificationBox.allNotifications.length === 0) {
          resolve();
        }
      });
      notification.close();
    }

  });
}

function whenDelayedStartupFinished(aWindow, aCallback) {
  Services.obs.addObserver(function observer(aSubject, aTopic) {
    if (aWindow == aSubject) {
      Services.obs.removeObserver(observer, aTopic);
      executeSoon(aCallback);
    }
  }, "browser-delayed-startup-finished");
}

function openToolbarCustomizationUI(aCallback, aBrowserWin) {
  if (!aBrowserWin)
    aBrowserWin = window;

  aBrowserWin.gCustomizeMode.enter();

  aBrowserWin.gNavToolbox.addEventListener("customizationready", function() {
    executeSoon(function() {
      aCallback(aBrowserWin);
    });
  }, {once: true});
}

function closeToolbarCustomizationUI(aCallback, aBrowserWin) {
  aBrowserWin.gNavToolbox.addEventListener("aftercustomization", function() {
    executeSoon(aCallback);
  }, {once: true});

  aBrowserWin.gCustomizeMode.exit();
}

function waitForCondition(condition, nextTest, errorMsg, retryTimes) {
  retryTimes = typeof retryTimes !== "undefined" ? retryTimes : 30;
  var tries = 0;
  var interval = setInterval(function() {
    if (tries >= retryTimes) {
      ok(false, errorMsg);
      moveOn();
    }
    var conditionPassed;
    try {
      conditionPassed = condition();
    } catch (e) {
      ok(false, e + "\n" + e.stack);
      conditionPassed = false;
    }
    if (conditionPassed) {
      moveOn();
    }
    tries++;
  }, 100);
  var moveOn = function() { clearInterval(interval); nextTest(); };
}

function promiseWaitForCondition(aConditionFn) {
  return new Promise(resolve => {
    waitForCondition(aConditionFn, resolve, "Condition didn't pass.");
  });
}

function promiseWaitForEvent(object, eventName, capturing = false, chrome = false) {
  return new Promise((resolve) => {
    function listener(event) {
      info("Saw " + eventName);
      object.removeEventListener(eventName, listener, capturing, chrome);
      resolve(event);
    }

    info("Waiting for " + eventName);
    object.addEventListener(eventName, listener, capturing, chrome);
  });
}

/**
 * Allows setting focus on a window, and waiting for that window to achieve
 * focus.
 *
 * @param aWindow
 *        The window to focus and wait for.
 *
 * @return {Promise}
 * @resolves When the window is focused.
 * @rejects Never.
 */
function promiseWaitForFocus(aWindow) {
  return new Promise((resolve) => {
    waitForFocus(resolve, aWindow);
  });
}

function getTestPlugin(aName) {
  var pluginName = aName || "Test Plug-in";
  var ph = Cc["@mozilla.org/plugin/host;1"].getService(Ci.nsIPluginHost);
  var tags = ph.getPluginTags();

  // Find the test plugin
  for (var i = 0; i < tags.length; i++) {
    if (tags[i].name == pluginName)
      return tags[i];
  }
  ok(false, "Unable to find plugin");
  return null;
}

// call this to set the test plugin(s) initially expected enabled state.
// it will automatically be reset to it's previous value after the test
// ends
function setTestPluginEnabledState(newEnabledState, pluginName) {
  var plugin = getTestPlugin(pluginName);
  var oldEnabledState = plugin.enabledState;
  plugin.enabledState = newEnabledState;
  SimpleTest.registerCleanupFunction(function() {
    getTestPlugin(pluginName).enabledState = oldEnabledState;
  });
}

function pushPrefs(...aPrefs) {
  return new Promise(resolve => {
    SpecialPowers.pushPrefEnv({"set": aPrefs}, resolve);
  });
}

function popPrefs() {
  return new Promise(resolve => {
    SpecialPowers.popPrefEnv(resolve);
  });
}

function updateBlocklist(aCallback) {
  var blocklistNotifier = Cc["@mozilla.org/extensions/blocklist;1"]
                          .getService(Ci.nsITimerCallback);
  var observer = function() {
    Services.obs.removeObserver(observer, "blocklist-updated");
    SimpleTest.executeSoon(aCallback);
  };
  Services.obs.addObserver(observer, "blocklist-updated");
  blocklistNotifier.notify(null);
}

var _originalTestBlocklistURL = null;
function setAndUpdateBlocklist(aURL, aCallback) {
  if (!_originalTestBlocklistURL)
    _originalTestBlocklistURL = Services.prefs.getCharPref("extensions.blocklist.url");
  Services.prefs.setCharPref("extensions.blocklist.url", aURL);
  updateBlocklist(aCallback);
}

function resetBlocklist() {
  Services.prefs.setCharPref("extensions.blocklist.url", _originalTestBlocklistURL);
}

function whenNewWindowLoaded(aOptions, aCallback) {
  let win = OpenBrowserWindow(aOptions);
  win.addEventListener("load", function() {
    aCallback(win);
  }, {once: true});
}

function promiseWindowClosed(win) {
  let promise = BrowserTestUtils.domWindowClosed(win);
  win.close();
  return promise;
}

function promiseOpenAndLoadWindow(aOptions, aWaitForDelayedStartup = false) {
  return new Promise(resolve => {
    let win = OpenBrowserWindow(aOptions);
    if (aWaitForDelayedStartup) {
      Services.obs.addObserver(function onDS(aSubject, aTopic, aData) {
        if (aSubject != win) {
          return;
        }
        Services.obs.removeObserver(onDS, "browser-delayed-startup-finished");
        resolve(win);
      }, "browser-delayed-startup-finished");

    } else {
      win.addEventListener("load", function() {
        resolve(win);
      }, {once: true});
    }
  });
}

function whenNewTabLoaded(aWindow, aCallback) {
  aWindow.BrowserOpenTab();

  let browser = aWindow.gBrowser.selectedBrowser;
  let doc = browser.contentDocumentAsCPOW;
  if (doc && doc.readyState === "complete") {
    aCallback();
    return;
  }

  whenTabLoaded(aWindow.gBrowser.selectedTab, aCallback);
}

function whenTabLoaded(aTab, aCallback) {
  promiseTabLoadEvent(aTab).then(aCallback);
}

function promiseTabLoaded(aTab) {
  return new Promise(resolve => {
    whenTabLoaded(aTab, resolve);
  });
}

var FullZoomHelper = {

  selectTabAndWaitForLocationChange: function selectTabAndWaitForLocationChange(tab) {
    if (!tab)
      throw new Error("tab must be given.");
    if (gBrowser.selectedTab == tab)
      return Promise.resolve();

    return Promise.all([BrowserTestUtils.switchTab(gBrowser, tab),
                        this.waitForLocationChange()]);
  },

  removeTabAndWaitForLocationChange: function removeTabAndWaitForLocationChange(tab) {
    tab = tab || gBrowser.selectedTab;
    let selected = gBrowser.selectedTab == tab;
    gBrowser.removeTab(tab);
    if (selected)
      return this.waitForLocationChange();
    return Promise.resolve();
  },

  waitForLocationChange: function waitForLocationChange() {
    return new Promise(resolve => {
      Services.obs.addObserver(function obs(subj, topic, data) {
        Services.obs.removeObserver(obs, topic);
        resolve();
      }, "browser-fullZoom:location-change");
    });
  },

  load: function load(tab, url) {
    return new Promise(resolve => {
      let didLoad = false;
      let didZoom = false;

      promiseTabLoadEvent(tab).then(event => {
        didLoad = true;
        if (didZoom)
          resolve();
      }, true);

      this.waitForLocationChange().then(function() {
        didZoom = true;
        if (didLoad)
          resolve();
      });

      tab.linkedBrowser.loadURI(url);
    });
  },

  zoomTest: function zoomTest(tab, val, msg) {
    is(ZoomManager.getZoomForBrowser(tab.linkedBrowser), val, msg);
  },

  enlarge: function enlarge() {
    return new Promise(resolve => FullZoom.enlarge(resolve));
  },

  reduce: function reduce() {
    return new Promise(resolve => FullZoom.reduce(resolve));
  },

  reset: function reset() {
    return FullZoom.reset();
  },

  BACK: 0,
  FORWARD: 1,
  navigate: function navigate(direction) {
    return new Promise(resolve => {
      let didPs = false;
      let didZoom = false;

      BrowserTestUtils.waitForContentEvent(gBrowser.selectedBrowser, "pageshow", true).then(() => {
        didPs = true;
        if (didZoom)
          resolve();
      });

      if (direction == this.BACK)
        gBrowser.goBack();
      else if (direction == this.FORWARD)
        gBrowser.goForward();

      this.waitForLocationChange().then(function() {
        didZoom = true;
        if (didPs)
          resolve();
      });
    });
  },

  failAndContinue: function failAndContinue(func) {
    return function(err) {
      ok(false, err);
      func();
    };
  },
};

/**
 * Waits for a load (or custom) event to finish in a given tab. If provided
 * load an uri into the tab.
 *
 * @param tab
 *        The tab to load into.
 * @param [optional] url
 *        The url to load, or the current url.
 * @return {Promise} resolved when the event is handled.
 * @resolves to the received event
 * @rejects if a valid load event is not received within a meaningful interval
 */
function promiseTabLoadEvent(tab, url) {
  info("Wait tab event: load");

  function handle(loadedUrl) {
    if (loadedUrl === "about:blank" || (url && loadedUrl !== url)) {
      info(`Skipping spurious load event for ${loadedUrl}`);
      return false;
    }

    info("Tab event received: load");
    return true;
  }

  let loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, handle);

  if (url)
    BrowserTestUtils.loadURI(tab.linkedBrowser, url);

  return loaded;
}

/**
 * Returns a Promise that resolves once a new tab has been opened in
 * a xul:tabbrowser.
 *
 * @param aTabBrowser
 *        The xul:tabbrowser to monitor for a new tab.
 * @return {Promise}
 *        Resolved when the new tab has been opened.
 * @resolves to the TabOpen event that was fired.
 * @rejects Never.
 */
function waitForNewTabEvent(aTabBrowser) {
  return promiseWaitForEvent(aTabBrowser.tabContainer, "TabOpen");
}

function is_hidden(element) {
  var style = element.ownerGlobal.getComputedStyle(element);
  if (style.display == "none")
    return true;
  if (style.visibility != "visible")
    return true;
  if (style.display == "-moz-popup")
    return ["hiding", "closed"].includes(element.state);

  // Hiding a parent element will hide all its children
  if (element.parentNode != element.ownerDocument)
    return is_hidden(element.parentNode);

  return false;
}

function is_element_visible(element, msg) {
  isnot(element, null, "Element should not be null, when checking visibility");
  ok(BrowserTestUtils.is_visible(element), msg || "Element should be visible");
}

function is_element_hidden(element, msg) {
  isnot(element, null, "Element should not be null, when checking visibility");
  ok(is_hidden(element), msg || "Element should be hidden");
}

function promisePopupEvent(popup, eventSuffix) {
  let endState = {shown: "open", hidden: "closed"}[eventSuffix];

  if (popup.state == endState)
    return Promise.resolve();

  let eventType = "popup" + eventSuffix;
  return new Promise(resolve => {
    popup.addEventListener(eventType, function(event) {
      resolve();
    }, {once: true});

  });
}

function promisePopupShown(popup) {
  return promisePopupEvent(popup, "shown");
}

function promisePopupHidden(popup) {
  return promisePopupEvent(popup, "hidden");
}

function promiseNotificationShown(notification) {
  let win = notification.browser.ownerGlobal;
  if (win.PopupNotifications.panel.state == "open") {
    return Promise.resolve();
  }
  let panelPromise = promisePopupShown(win.PopupNotifications.panel);
  notification.reshow();
  return panelPromise;
}

/**
 * Resolves when a bookmark with the given uri is added.
 */
function promiseOnBookmarkItemAdded(aExpectedURI) {
  return new Promise((resolve, reject) => {
    let bookmarksObserver = {
      onItemAdded(aItemId, aFolderId, aIndex, aItemType, aURI) {
        info("Added a bookmark to " + aURI.spec);
        PlacesUtils.bookmarks.removeObserver(bookmarksObserver);
        if (aURI.equals(aExpectedURI)) {
          resolve();
        } else {
          reject(new Error("Added an unexpected bookmark"));
        }
      },
      onBeginUpdateBatch() {},
      onEndUpdateBatch() {},
      onItemRemoved() {},
      onItemChanged() {},
      onItemVisited() {},
      onItemMoved() {},
      QueryInterface: ChromeUtils.generateQI([
        Ci.nsINavBookmarkObserver,
      ])
    };
    info("Waiting for a bookmark to be added");
    PlacesUtils.bookmarks.addObserver(bookmarksObserver);
  });
}

async function loadBadCertPage(url) {
  const EXCEPTION_DIALOG_URI = "chrome://pippki/content/exceptionDialog.xul";
  let exceptionDialogResolved = new Promise(function(resolve) {
    // When the certificate exception dialog has opened, click the button to add
    // an exception.
    let certExceptionDialogObserver = {
      observe(aSubject, aTopic, aData) {
        if (aTopic == "cert-exception-ui-ready") {
          Services.obs.removeObserver(this, "cert-exception-ui-ready");
          let certExceptionDialog = getCertExceptionDialog(EXCEPTION_DIALOG_URI);
          ok(certExceptionDialog, "found exception dialog");
          executeSoon(function() {
            certExceptionDialog.documentElement.getButton("extra1").click();
            resolve();
          });
        }
      }
    };

    Services.obs.addObserver(certExceptionDialogObserver,
                             "cert-exception-ui-ready");
  });

  let loaded = BrowserTestUtils.waitForErrorPage(gBrowser.selectedBrowser);
  await BrowserTestUtils.loadURI(gBrowser.selectedBrowser, url);
  await loaded;

  await ContentTask.spawn(gBrowser.selectedBrowser, null, async function() {
    content.document.getElementById("exceptionDialogButton").click();
  });
  if (!Services.prefs.getBoolPref("browser.security.newcerterrorpage.enabled", false)) {
    await exceptionDialogResolved;
  }
  await BrowserTestUtils.browserLoaded(gBrowser.selectedBrowser);
}

// Utility function to get a handle on the certificate exception dialog.
// Modified from toolkit/components/passwordmgr/test/prompt_common.js
function getCertExceptionDialog(aLocation) {
  for (let {docShell} of Services.wm.getXULWindowEnumerator(null)) {
    let containedDocShells = docShell.getDocShellEnumerator(
                                      docShell.typeChrome,
                                      docShell.ENUMERATE_FORWARDS);
    for (let {domWindow} of containedDocShells) {
      if (domWindow.location.href == aLocation) {
        return domWindow.document;
      }
    }
  }
  return undefined;
}
