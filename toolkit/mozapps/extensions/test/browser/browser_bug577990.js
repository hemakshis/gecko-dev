/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

// Tests that the visible delay in showing the "Language" category occurs
// very minimally

var gManagerWindow;
var gCategoryUtilities;
var gProvider;
var gInstall;
var gInstallProperties = [{
  name: "Locale Category Test",
  type: "locale"
}];

async function test() {
  try {
    if (Cc["@mozilla.org/gfx/info;1"].getService(Ci.nsIGfxInfo).D2DEnabled) {
      requestLongerTimeout(2);
    }
  } catch (e) {}
  waitForExplicitFinish();

  gProvider = new MockProvider();

  let aWindow = await open_manager("addons://list/extension");
  gManagerWindow = aWindow;
  gCategoryUtilities = new CategoryUtilities(gManagerWindow);
  run_next_test();
}

function end_test() {
  close_manager(gManagerWindow, finish);
}

function install_locale(aCallback) {
  gInstall = gProvider.createInstalls(gInstallProperties)[0];
  gInstall.addTestListener({
    onInstallEnded(aInstall) {
      gInstall.removeTestListener(this);
      executeSoon(aCallback);
    }
  });
  gInstall.install();
}

function check_hidden(aExpectedHidden) {
  var hidden = !gCategoryUtilities.isTypeVisible("locale");
  is(hidden, !!aExpectedHidden, "Should have correct hidden state");
}

async function run_open_test(aTestSetup, aLoadHidden, aInitializedHidden, aSelected) {
  function loadCallback(aManagerWindow) {
    gManagerWindow = aManagerWindow;
    gCategoryUtilities = new CategoryUtilities(gManagerWindow);
    check_hidden(aLoadHidden);
  }

  async function run() {
    await open_manager(null, null, loadCallback);
    check_hidden(aInitializedHidden);
    var selected = (gCategoryUtilities.selectedCategory == "locale");
    is(selected, !!aSelected, "Should have correct selected state");

    run_next_test();
  }

  await close_manager(gManagerWindow);
  aTestSetup ? aTestSetup(run) : run();
}


// Tests that the locale category is hidden when there are no locales installed
add_test(function() {
  run_open_test(null, true, true);
});

// Tests that installing a locale while the Add-on Manager is open shows the
// locale category
add_test(function() {
  check_hidden(true);
  install_locale(function() {
    check_hidden(false);
    run_next_test();
  });
});

// Tests that the locale category is shown with no delay when restarting
// Add-on Manager
add_test(function() {
  run_open_test(null, false, false);
});

// Tests that cancelling the locale install and restarting the Add-on Manager
// causes the locale category to be hidden with an acceptable delay
add_test(function() {
  gInstall.cancel();
  run_open_test(null, false, true);
});

// Tests that the locale category is hidden with no delay when restarting
// Add-on Manager
add_test(function() {
  run_open_test(null, true, true);
});

// Tests that installing a locale when the Add-on Manager is closed, and then
// opening the Add-on Manager causes the locale category to be shown with an
// acceptable delay
add_test(function() {
  run_open_test(install_locale, true, false);
});

// Tests that selection of the locale category persists
add_test(async function() {
  await gCategoryUtilities.openType("locale");
  run_open_test(null, false, false, true);
});

// Tests that cancelling the locale install and restarting the Add-on Manager
// causes the locale category to be hidden and not selected
add_test(function() {
  gInstall.cancel();
  run_open_test(null, false, true);
});

