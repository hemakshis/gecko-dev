/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

const TEST_VALUE = "example.com";
const START_VALUE = "example.org";

add_task(async function setup() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.altClickSave", true],
          ["browser.urlbar.autoFill", false]],
  });
});

add_task(async function alt_left_click_test() {
  info("Running test: Alt left click");

  // Monkey patch saveURL() to avoid dealing with file save code paths.
  let oldSaveURL = saveURL;
  let saveURLPromise = new Promise(resolve => {
    saveURL = () => {
      // Restore old saveURL() value.
      saveURL = oldSaveURL;
      resolve();
    };
  });

  triggerCommand(true, {altKey: true});

  await saveURLPromise;
  ok(true, "SaveURL was called");
  is(gURLBar.value, "", "Urlbar reverted to original value");
});

add_task(async function shift_left_click_test() {
  info("Running test: Shift left click");

  let newWindowPromise = BrowserTestUtils.waitForNewWindow();
  triggerCommand(true, {shiftKey: true});
  let win = await newWindowPromise;

  // Wait for the initial browser to load.
  let browser = win.gBrowser.selectedBrowser;
  let destinationURL = "http://" + TEST_VALUE + "/";
  await Promise.all([
    BrowserTestUtils.browserLoaded(browser),
    BrowserTestUtils.waitForLocationChange(win.gBrowser, destinationURL)
  ]);

  info("URL should be loaded in a new window");
  is(gURLBar.value, "", "Urlbar reverted to original value");
  await promiseCheckChildNoFocusedElement(gBrowser.selectedBrowser);
  is(document.activeElement, gBrowser.selectedBrowser, "Content window should be focused");
  is(win.gURLBar.textValue, TEST_VALUE, "New URL is loaded in new window");

  // Cleanup.
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function right_click_test() {
  info("Running test: Right click on go button");

  // Add a new tab.
  await promiseOpenNewTab();

  triggerCommand(true, {button: 2});

  // Right click should do nothing (context menu will be shown).
  is(gURLBar.value, TEST_VALUE, "Urlbar still has the value we entered");

  // Cleanup.
  gBrowser.removeCurrentTab();
});

add_task(async function shift_accel_left_click_test() {
  info("Running test: Shift+Ctrl/Cmd left click on go button");

  // Add a new tab.
  let tab = await promiseOpenNewTab();

  let loadStartedPromise = promiseLoadStarted();
  triggerCommand(true, {accelKey: true, shiftKey: true});
  await loadStartedPromise;

  // Check the load occurred in a new background tab.
  info("URL should be loaded in a new background tab");
  is(gURLBar.value, "", "Urlbar reverted to original value");
  ok(!gURLBar.focused, "Urlbar is no longer focused after urlbar command");
  is(gBrowser.selectedTab, tab, "Focus did not change to the new tab");

  // Select the new background tab
  gBrowser.selectedTab = gBrowser.selectedTab.nextElementSibling;
  is(gURLBar.value, TEST_VALUE, "New URL is loaded in new tab");

  // Cleanup.
  gBrowser.removeCurrentTab();
  gBrowser.removeCurrentTab();
});

add_task(async function load_in_current_tab_test() {
  let tests = [
    {desc: "Simple return keypress"},
    {desc: "Left click on go button", click: true},
    {desc: "Ctrl/Cmd+Return keypress", event: {accelKey: true}},
    {desc: "Alt+Return keypress in a blank tab", event: {altKey: true}}
  ];

  for (let test of tests) {
    info(`Running test: ${test.desc}`);

    // Add a new tab.
    let tab = await promiseOpenNewTab();

    // Trigger a load and check it occurs in the current tab.
    let loadStartedPromise = promiseLoadStarted();
    triggerCommand(test.click || false, test.event || {});
    await loadStartedPromise;

    info("URL should be loaded in the current tab");
    is(gURLBar.value, TEST_VALUE, "Urlbar still has the value we entered");
    await promiseCheckChildNoFocusedElement(gBrowser.selectedBrowser);
    is(document.activeElement, gBrowser.selectedBrowser, "Content window should be focused");
    is(gBrowser.selectedTab, tab, "New URL was loaded in the current tab");

    // Cleanup.
    gBrowser.removeCurrentTab();
  }
});

add_task(async function load_in_new_tab_test() {
  let tests = [
    {desc: "Ctrl/Cmd left click on go button", click: true, event: {accelKey: true}},
    {desc: "Alt+Return keypress in a dirty tab", event: {altKey: true}, url: START_VALUE}
  ];

  for (let test of tests) {
    info(`Running test: ${test.desc}`);

    // Add a new tab.
    let tab = await promiseOpenNewTab(test.url || "about:blank");

    // Trigger a load and check it occurs in the current tab.
    let tabSwitchedPromise = promiseNewTabSwitched();
    triggerCommand(test.click || false, test.event || {});
    await tabSwitchedPromise;

    // Check the load occurred in a new tab.
    info("URL should be loaded in a new focused tab");
    is(gURLBar.inputField.value, TEST_VALUE, "Urlbar still has the value we entered");
    await promiseCheckChildNoFocusedElement(gBrowser.selectedBrowser);
    is(document.activeElement, gBrowser.selectedBrowser, "Content window should be focused");
    isnot(gBrowser.selectedTab, tab, "New URL was loaded in a new tab");

    // Cleanup.
    gBrowser.removeCurrentTab();
    gBrowser.removeCurrentTab();
  }
});

function triggerCommand(shouldClick, event) {
  gURLBar.focus();
  gURLBar.value = "";
  EventUtils.sendString(TEST_VALUE);

  if (shouldClick) {
    ok(gURLBar.hasAttribute("usertyping"),
       "usertyping attribute must be set for the go button to be visible");

    EventUtils.synthesizeMouseAtCenter(gURLBar.goButton, event);
  } else {
    EventUtils.synthesizeKey("KEY_Enter", event);
  }
}

function promiseLoadStarted() {
  return new Promise(resolve => {
    gBrowser.addTabsProgressListener({
      onStateChange(browser, webProgress, req, flags, status) {
        if (flags & Ci.nsIWebProgressListener.STATE_START) {
          gBrowser.removeTabsProgressListener(this);
          resolve();
        }
      }
    });
  });
}

async function promiseOpenNewTab(url = "about:blank") {
  let tab = BrowserTestUtils.addTab(gBrowser, url);
  let tabSwitchPromise = promiseNewTabSwitched(tab);
  gBrowser.selectedTab = tab;
  await BrowserTestUtils.browserLoaded(gBrowser.selectedBrowser);
  await tabSwitchPromise;
  return tab;
}

function promiseNewTabSwitched() {
  return new Promise(resolve => {
    gBrowser.addEventListener("TabSwitchDone", function() {
      executeSoon(resolve);
    }, {once: true});
  });
}

function promiseCheckChildNoFocusedElement(browser) {
  if (!gMultiProcessBrowser) {
    Assert.equal(Services.focus.focusedElement, null, "There should be no focused element");
    return null;
  }

  return ContentTask.spawn(browser, { }, async function() {
    Assert.equal(Services.focus.focusedElement, null, "There should be no focused element");
  });
}
