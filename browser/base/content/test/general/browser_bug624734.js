/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

// Bug 624734 - Star UI has no tooltip until bookmarked page is visited

function finishTest() {
  is(document.getElementById("context-bookmarkpage").getAttribute("tooltiptext"),
     BookmarkingUI._unstarredTooltip,
     "Context menu should have the unstarred tooltip text");
  is(BookmarkingUI.star.getAttribute("tooltiptext"),
     BookmarkingUI._unstarredTooltip,
     "Star icon should have the unstarred tooltip text");

  gBrowser.removeCurrentTab();
  finish();
}

function test() {
  waitForExplicitFinish();

  let tab = gBrowser.selectedTab = BrowserTestUtils.addTab(gBrowser);
  CustomizableUI.addWidgetToArea("bookmarks-menu-button", CustomizableUI.AREA_NAVBAR, 0);
  BrowserTestUtils.browserLoaded(tab.linkedBrowser).then(() => {
    if (BookmarkingUI.status == BookmarkingUI.STATUS_UPDATING) {
      waitForCondition(() => BookmarkingUI.status != BookmarkingUI.STATUS_UPDATING, finishTest, "BookmarkingUI was updating for too long");
    } else {
      CustomizableUI.removeWidgetFromArea("bookmarks-menu-button");
      finishTest();
    }
  });

  tab.linkedBrowser.loadURI("http://example.com/browser/browser/base/content/test/general/dummy_page.html");
}
