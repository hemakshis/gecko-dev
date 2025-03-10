/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * WHOA THERE: We should never be adding new things to EXPECTED_REFLOWS. This
 * is a whitelist that should slowly go away as we improve the performance of
 * the front-end. Instead of adding more reflows to the whitelist, you should
 * be modifying your code to avoid the reflow.
 *
 * See https://developer.mozilla.org/en-US/Firefox/Performance_best_practices_for_Firefox_fe_engineers
 * for tips on how to do that.
 */
const EXPECTED_REFLOWS = [
  /**
   * Nothing here! Please don't add anything new!
   */
];

if (Services.appinfo.OS == "WINNT") {
  EXPECTED_REFLOWS.push(
    {
      stack: [
        "verticalMargins@chrome://browser/content/browser-tabsintitlebar.js",
        "_layOutTitlebar@chrome://browser/content/browser-tabsintitlebar.js",
        "update@chrome://browser/content/browser-tabsintitlebar.js",
        "whenWindowLayoutReady@chrome://browser/content/browser-tabsintitlebar.js",
      ],
      maxCount: 2, // This number should only ever go down - never up.
    },
  );
}

if (Services.appinfo.OS == "WINNT" || Services.appinfo.OS == "Darwin") {
  EXPECTED_REFLOWS.push(
    {
      stack: [
        "rect@chrome://browser/content/browser-tabsintitlebar.js",
        "_layOutTitlebar@chrome://browser/content/browser-tabsintitlebar.js",
        "update@chrome://browser/content/browser-tabsintitlebar.js",
        "whenWindowLayoutReady@chrome://browser/content/browser-tabsintitlebar.js",
      ],
      // These numbers should only ever go down - never up.
      maxCount: Services.appinfo.OS == "WINNT" ? 5 : 4,
    },
  );
}

/*
 * This test ensures that there are no unexpected
 * uninterruptible reflows or flickering areas when opening new windows.
 */
add_task(async function() {
  // Flushing all caches helps to ensure that we get consistent
  // behaviour when opening a new window, even if windows have been
  // opened in previous tests.
  Services.obs.notifyObservers(null, "startupcache-invalidate");
  Services.obs.notifyObservers(null, "chrome-flush-skin-caches");
  Services.obs.notifyObservers(null, "chrome-flush-caches");

  let win = window.openDialog(AppConstants.BROWSER_CHROME_URL, "_blank",
                              "chrome,all,dialog=no,remote,suppressanimation",
                              "about:home");

  let alreadyFocused = false;
  let inRange = (val, min, max) => min <= val && val <= max;
  let expectations = {
    expectedReflows: EXPECTED_REFLOWS,
    frames: {
      filter(rects, frame, previousFrame) {
        // The first screenshot we get in OSX / Windows shows an unfocused browser
        // window for some reason. See bug 1445161.
        //
        // We'll assume the changes we are seeing are due to this focus change if
        // there are at least 5 areas that changed near the top of the screen, but
        // will only ignore this once (hence the alreadyFocused variable).
        if (!alreadyFocused && rects.length > 5 && rects.every(r => r.y2 < 100)) {
          alreadyFocused = true;
          todo(false,
               "bug 1445161 - the window should be focused at first paint, " +
               rects.toSource());
          return [];
        }

        return rects;
      },
      exceptions: [
        {name: "bug 1421463 - reload toolbar icon shouldn't flicker",
         condition: r => inRange(r.h, 13, 14) && inRange(r.w, 14, 16) && // icon size
                         inRange(r.y1, 40, 80) && // in the toolbar
                         // near the left side of the screen
                         // The reload icon is shifted on devedition builds
                         // where there's an additional devtools toolbar icon.
                         AppConstants.MOZ_DEV_EDITION ? inRange(r.x1, 100, 120) :
                                                        inRange(r.x1, 65, 100)
        },
      ]
    }
  };

  await withPerfObserver(async function() {
    // Avoid showing the remotecontrol UI.
    await new Promise(resolve => {
      win.addEventListener("DOMContentLoaded", () => {
        delete win.Marionette;
        win.Marionette = {running: false};
        resolve();
      }, {once: true});
    });

    await TestUtils.topicObserved("browser-delayed-startup-finished",
                                  subject => subject == win);

    await BrowserTestUtils.firstBrowserLoaded(win, false);
    await BrowserTestUtils.browserStopped(win.gBrowser.selectedBrowser, "about:home");

    if (Services.appinfo.OS == "WINNT" && win.windowState == win.STATE_MAXIMIZED) {
      // The reflows below are triggered by maximizing the window after
      // layout. They should be fixed by bug 1447864.
      EXPECTED_REFLOWS.push(
        {
          stack: [
            "rect@chrome://browser/content/browser-tabsintitlebar.js",
            "_layOutTitlebar@chrome://browser/content/browser-tabsintitlebar.js",
            "update@chrome://browser/content/browser-tabsintitlebar.js",
            "handleEvent@chrome://browser/content/browser-tabsintitlebar.js",
          ],
          maxCount: 4,
        },
        {
          stack: [
            "verticalMargins@chrome://browser/content/browser-tabsintitlebar.js",
            "_layOutTitlebar@chrome://browser/content/browser-tabsintitlebar.js",
            "update@chrome://browser/content/browser-tabsintitlebar.js",
            "handleEvent@chrome://browser/content/browser-tabsintitlebar.js",
          ],
          maxCount: 2,
        },
      );
    }

    await new Promise(resolve => {
      // 10 is an arbitrary value here, it needs to be at least 2 to avoid
      // races with code initializing itself using idle callbacks.
      (function waitForIdle(count = 10) {
        if (!count) {
          resolve();
          return;
        }
        Services.tm.idleDispatchToMainThread(() => {
          waitForIdle(count - 1);
        });
      })();
    });
  }, expectations, win);

  await BrowserTestUtils.closeWindow(win);
});
