function hideSelectPopup(selectPopup, mode = "enter", win = window) {
  let browser = win.gBrowser.selectedBrowser;
  let selectClosedPromise = ContentTask.spawn(browser, null, async function() {
    let {SelectContentHelper} =
      ChromeUtils.import("resource://gre/actors/SelectChild.jsm", {});
    return ContentTaskUtils.waitForCondition(() => !SelectContentHelper.open);
  });

  if (mode == "escape") {
    EventUtils.synthesizeKey("KEY_Escape", {}, win);
  } else if (mode == "enter") {
    EventUtils.synthesizeKey("KEY_Enter", {}, win);
  } else if (mode == "click") {
    EventUtils.synthesizeMouseAtCenter(selectPopup.lastChild, { }, win);
  }

  return selectClosedPromise;
}
