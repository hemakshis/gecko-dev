ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");

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
  return BrowserTestUtils.waitForEvent(aTabBrowser.tabContainer, "TabOpen");
}

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

// Compares the security state of the page with what is expected
function isSecurityState(browser, expectedState) {
  let ui = browser.securityUI;
  if (!ui) {
    ok(false, "No security UI to get the security state");
    return;
  }

  const wpl = Ci.nsIWebProgressListener;

  // determine the security state
  let isSecure = ui.state & wpl.STATE_IS_SECURE;
  let isBroken = ui.state & wpl.STATE_IS_BROKEN;
  let isInsecure = ui.state & wpl.STATE_IS_INSECURE;

  let actualState;
  if (isSecure && !(isBroken || isInsecure)) {
    actualState = "secure";
  } else if (isBroken && !(isSecure || isInsecure)) {
    actualState = "broken";
  } else if (isInsecure && !(isSecure || isBroken)) {
    actualState = "insecure";
  } else {
    actualState = "unknown";
  }

  is(expectedState, actualState, "Expected state " + expectedState + " and the actual state is " + actualState + ".");
}

/**
 * Test the state of the identity box and control center to make
 * sure they are correctly showing the expected mixed content states.
 *
 * @note The checks are done synchronously, but new code should wait on the
 *       returned Promise object to ensure the identity panel has closed.
 *       Bug 1221114 is filed to fix the existing code.
 *
 * @param tabbrowser
 * @param Object states
 *        MUST include the following properties:
 *        {
 *           activeLoaded: true|false,
 *           activeBlocked: true|false,
 *           passiveLoaded: true|false,
 *        }
 *
 * @return {Promise}
 * @resolves When the operation has finished and the identity panel has closed.
 */
async function assertMixedContentBlockingState(tabbrowser, states = {}) {
  if (!tabbrowser || !("activeLoaded" in states) ||
      !("activeBlocked" in states) || !("passiveLoaded" in states)) {
    throw new Error("assertMixedContentBlockingState requires a browser and a states object");
  }

  let {passiveLoaded, activeLoaded, activeBlocked} = states;
  let {gIdentityHandler} = tabbrowser.ownerGlobal;
  let doc = tabbrowser.ownerDocument;
  let identityBox = gIdentityHandler._identityBox;
  let classList = identityBox.classList;
  let connectionIcon = doc.getElementById("connection-icon");
  let connectionIconImage = tabbrowser.ownerGlobal.getComputedStyle(connectionIcon).
                         getPropertyValue("list-style-image");

  let stateSecure = gIdentityHandler._state & Ci.nsIWebProgressListener.STATE_IS_SECURE;
  let stateBroken = gIdentityHandler._state & Ci.nsIWebProgressListener.STATE_IS_BROKEN;
  let stateInsecure = gIdentityHandler._state & Ci.nsIWebProgressListener.STATE_IS_INSECURE;
  let stateActiveBlocked = gIdentityHandler._state & Ci.nsIWebProgressListener.STATE_BLOCKED_MIXED_ACTIVE_CONTENT;
  let stateActiveLoaded = gIdentityHandler._state & Ci.nsIWebProgressListener.STATE_LOADED_MIXED_ACTIVE_CONTENT;
  let statePassiveLoaded = gIdentityHandler._state & Ci.nsIWebProgressListener.STATE_LOADED_MIXED_DISPLAY_CONTENT;

  is(activeBlocked, !!stateActiveBlocked, "Expected state for activeBlocked matches UI state");
  is(activeLoaded, !!stateActiveLoaded, "Expected state for activeLoaded matches UI state");
  is(passiveLoaded, !!statePassiveLoaded, "Expected state for passiveLoaded matches UI state");

  if (stateInsecure) {
    const insecureConnectionIcon = Services.prefs.getBoolPref("security.insecure_connection_icon.enabled");
    if (!insecureConnectionIcon) {
      // HTTP request, there should be no MCB classes for the identity box and the non secure icon
      // should always be visible regardless of MCB state.
      ok(classList.contains("unknownIdentity"), "unknownIdentity on HTTP page");
      ok(BrowserTestUtils.is_hidden(connectionIcon), "connection icon should be hidden");
    } else {
      // HTTP request, there should be a broken padlock shown always.
      ok(classList.contains("notSecure"), "notSecure on HTTP page");
      ok(!BrowserTestUtils.is_hidden(connectionIcon), "connection icon should be visible");
    }

    ok(!classList.contains("mixedActiveContent"), "No MCB icon on HTTP page");
    ok(!classList.contains("mixedActiveBlocked"), "No MCB icon on HTTP page");
    ok(!classList.contains("mixedDisplayContent"), "No MCB icon on HTTP page");
    ok(!classList.contains("mixedDisplayContentLoadedActiveBlocked"), "No MCB icon on HTTP page");
  } else {
    // Make sure the identity box UI has the correct mixedcontent states and icons
    is(classList.contains("mixedActiveContent"), activeLoaded,
        "identityBox has expected class for activeLoaded");
    is(classList.contains("mixedActiveBlocked"), activeBlocked && !passiveLoaded,
        "identityBox has expected class for activeBlocked && !passiveLoaded");
    is(classList.contains("mixedDisplayContent"), passiveLoaded && !(activeLoaded || activeBlocked),
       "identityBox has expected class for passiveLoaded && !(activeLoaded || activeBlocked)");
    is(classList.contains("mixedDisplayContentLoadedActiveBlocked"), passiveLoaded && activeBlocked,
       "identityBox has expected class for passiveLoaded && activeBlocked");

    ok(!BrowserTestUtils.is_hidden(connectionIcon), "connection icon should be visible");
    if (activeLoaded) {
      is(connectionIconImage, "url(\"chrome://browser/skin/connection-mixed-active-loaded.svg\")",
        "Using active loaded icon");
    }
    if (activeBlocked && !passiveLoaded) {
      is(connectionIconImage, "url(\"chrome://browser/skin/connection-secure.svg\")",
        "Using active blocked icon");
    }
    if (passiveLoaded && !(activeLoaded || activeBlocked)) {
      is(connectionIconImage, "url(\"chrome://browser/skin/connection-mixed-passive-loaded.svg\")",
        "Using passive loaded icon");
    }
    if (passiveLoaded && activeBlocked) {
      is(connectionIconImage, "url(\"chrome://browser/skin/connection-mixed-passive-loaded.svg\")",
        "Using active blocked and passive loaded icon");
    }
  }

  // Make sure the identity popup has the correct mixedcontent states
  let promisePanelOpen = BrowserTestUtils.waitForEvent(gIdentityHandler._identityPopup, "popupshown");
  gIdentityHandler._identityBox.click();
  await promisePanelOpen;
  let popupAttr = doc.getElementById("identity-popup").getAttribute("mixedcontent");
  let bodyAttr = doc.getElementById("identity-popup-securityView-body").getAttribute("mixedcontent");

  is(popupAttr.includes("active-loaded"), activeLoaded,
      "identity-popup has expected attr for activeLoaded");
  is(bodyAttr.includes("active-loaded"), activeLoaded,
      "securityView-body has expected attr for activeLoaded");

  is(popupAttr.includes("active-blocked"), activeBlocked,
      "identity-popup has expected attr for activeBlocked");
  is(bodyAttr.includes("active-blocked"), activeBlocked,
      "securityView-body has expected attr for activeBlocked");

  is(popupAttr.includes("passive-loaded"), passiveLoaded,
      "identity-popup has expected attr for passiveLoaded");
  is(bodyAttr.includes("passive-loaded"), passiveLoaded,
      "securityView-body has expected attr for passiveLoaded");

  // Make sure the correct icon is visible in the Control Center.
  // This logic is controlled with CSS, so this helps prevent regressions there.
  let securityViewBG = tabbrowser.ownerGlobal
    .getComputedStyle(document.getElementById("identity-popup-securityView")
                              .getElementsByClassName("identity-popup-security-content")[0])
    .getPropertyValue("background-image");
  let securityContentBG = tabbrowser.ownerGlobal
    .getComputedStyle(document.getElementById("identity-popup-mainView")
                              .getElementsByClassName("identity-popup-security-content")[0])
    .getPropertyValue("background-image");

  if (stateInsecure) {
    is(securityViewBG, "url(\"chrome://browser/skin/controlcenter/conn-not-secure.svg\")",
      "CC using 'not secure' icon");
    is(securityContentBG, "url(\"chrome://browser/skin/controlcenter/conn-not-secure.svg\")",
      "CC using 'not secure' icon");
  }

  if (stateSecure) {
    is(securityViewBG, "url(\"chrome://browser/skin/controlcenter/connection.svg\")",
      "CC using secure icon");
    is(securityContentBG, "url(\"chrome://browser/skin/controlcenter/connection.svg\")",
      "CC using secure icon");
  }

  if (stateBroken) {
    if (activeLoaded) {
      is(securityViewBG, "url(\"chrome://browser/skin/controlcenter/mcb-disabled.svg\")",
        "CC using active loaded icon");
      is(securityContentBG, "url(\"chrome://browser/skin/controlcenter/mcb-disabled.svg\")",
        "CC using active loaded icon");
    } else if (activeBlocked || passiveLoaded) {
      is(securityViewBG, "url(\"chrome://browser/skin/controlcenter/connection.svg\")",
        "CC using degraded icon");
      is(securityContentBG, "url(\"chrome://browser/skin/controlcenter/connection.svg\")",
        "CC using degraded icon");
    } else {
      // There is a case here with weak ciphers, but no bc tests are handling this yet.
      is(securityViewBG, "url(\"chrome://browser/skin/controlcenter/connection.svg\")",
        "CC using degraded icon");
      is(securityContentBG, "url(\"chrome://browser/skin/controlcenter/connection.svg\")",
        "CC using degraded icon");
    }
  }

  if (activeLoaded || activeBlocked || passiveLoaded) {
    let promiseViewShown = BrowserTestUtils.waitForEvent(gIdentityHandler._identityPopup, "ViewShown");
    doc.getElementById("identity-popup-security-expander").click();
    await promiseViewShown;
    is(Array.filter(doc.getElementById("identity-popup-securityView")
                       .querySelectorAll(".identity-popup-mcb-learn-more"),
                    element => !BrowserTestUtils.is_hidden(element)).length, 1,
       "The 'Learn more' link should be visible once.");
  }

  if (gIdentityHandler._identityPopup.state != "closed") {
    let hideEvent = BrowserTestUtils.waitForEvent(gIdentityHandler._identityPopup, "popuphidden");
    info("Hiding identity popup");
    gIdentityHandler._identityPopup.hidePopup();
    await hideEvent;
  }
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
  for (let win of Services.wm.getXULWindowEnumerator(null)) {
    let windowDocShell = win.docShell;

    let containedDocShells = windowDocShell.getDocShellEnumerator(
                                      Ci.nsIDocShellTreeItem.typeChrome,
                                      Ci.nsIDocShell.ENUMERATE_FORWARDS);
    for (let {domWindow} of containedDocShells) {
      if (domWindow.location.href == aLocation) {
        return domWindow.document;
      }
    }
  }
  return undefined;
}
