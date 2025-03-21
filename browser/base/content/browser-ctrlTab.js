/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// This file is loaded into the browser window scope.
/* eslint-env mozilla/browser-window */

/**
 * Tab previews utility, produces thumbnails
 */
var tabPreviews = {
  get aspectRatio() {
    let { PageThumbUtils } = ChromeUtils.import("resource://gre/modules/PageThumbUtils.jsm", {});
    let [ width, height ] = PageThumbUtils.getThumbnailSize(window);
    delete this.aspectRatio;
    return this.aspectRatio = height / width;
  },

  get: function tabPreviews_get(aTab) {
    let uri = aTab.linkedBrowser.currentURI.spec;

    if (aTab.__thumbnail_lastURI &&
        aTab.__thumbnail_lastURI != uri) {
      aTab.__thumbnail = null;
      aTab.__thumbnail_lastURI = null;
    }

    if (aTab.__thumbnail)
      return aTab.__thumbnail;

    if (aTab.getAttribute("pending") == "true") {
      let img = new Image;
      img.src = PageThumbs.getThumbnailURL(uri);
      return img;
    }

    return this.capture(aTab, !aTab.hasAttribute("busy"));
  },

  capture: function tabPreviews_capture(aTab, aShouldCache) {
    let browser = aTab.linkedBrowser;
    let uri = browser.currentURI.spec;
    let canvas = PageThumbs.createCanvas(window);
    PageThumbs.shouldStoreThumbnail(browser, (aDoStore) => {
      if (aDoStore && aShouldCache) {
        PageThumbs.captureAndStore(browser, function() {
          let img = new Image;
          img.src = PageThumbs.getThumbnailURL(uri);
          aTab.__thumbnail = img;
          aTab.__thumbnail_lastURI = uri;
          canvas.getContext("2d").drawImage(img, 0, 0);
        });
      } else {
        PageThumbs.captureToCanvas(browser, canvas, () => {
          if (aShouldCache) {
            aTab.__thumbnail = canvas;
            aTab.__thumbnail_lastURI = uri;
          }
        });
      }
    });
    return canvas;
  },
};

var tabPreviewPanelHelper = {
  opening(host) {
    host.panel.hidden = false;

    var handler = this._generateHandler(host);
    host.panel.addEventListener("popupshown", handler);
    host.panel.addEventListener("popuphiding", handler);

    host._prevFocus = document.commandDispatcher.focusedElement;
  },
  _generateHandler(host) {
    var self = this;
    return function listener(event) {
      if (event.target == host.panel) {
        host.panel.removeEventListener(event.type, listener);
        self["_" + event.type](host);
      }
    };
  },
  _popupshown(host) {
    if ("setupGUI" in host)
      host.setupGUI();
  },
  _popuphiding(host) {
    if ("suspendGUI" in host)
      host.suspendGUI();

    if (host._prevFocus) {
      Services.focus.setFocus(host._prevFocus, Ci.nsIFocusManager.FLAG_NOSCROLL);
      host._prevFocus = null;
    } else
      gBrowser.selectedBrowser.focus();

    if (host.tabToSelect) {
      gBrowser.selectedTab = host.tabToSelect;
      host.tabToSelect = null;
    }
  }
};

/**
 * Ctrl-Tab panel
 */
var ctrlTab = {
  maxTabPreviews: 6,
  get panel() {
    delete this.panel;
    return this.panel = document.getElementById("ctrlTab-panel");
  },
  get showAllButton() {
    delete this.showAllButton;
    let button = this.makePreview(true);
    button.setAttribute("id", "ctrlTab-showAll");
    document.getElementById("ctrlTab-showAll-container").appendChild(button);
    return this.showAllButton = button;
  },
  get previews() {
    delete this.previews;
    let previewsContainer = document.getElementById("ctrlTab-previews");
    for (let i = 0; i < this.maxTabPreviews; i++) {
      previewsContainer.appendChild(this.makePreview(false));
    }
    // Ensure that showAllButton is in the document before returning the single
    // node list that includes both the previews and the button.
    this.showAllButton;
    return this.previews = this.panel.getElementsByClassName("ctrlTab-preview");
  },
  get canvasWidth() {
    delete this.canvasWidth;
    return this.canvasWidth = Math.ceil(screen.availWidth * .85 / this.maxTabPreviews);
  },
  get canvasHeight() {
    delete this.canvasHeight;
    return this.canvasHeight = Math.round(this.canvasWidth * tabPreviews.aspectRatio);
  },
  get keys() {
    var keys = {};
    ["close", "find", "selectAll"].forEach(function(key) {
      keys[key] = document.getElementById("key_" + key)
                          .getAttribute("key")
                          .toLocaleLowerCase().charCodeAt(0);
    });
    delete this.keys;
    return this.keys = keys;
  },
  _selectedIndex: 0,
  get selected() {
    return this._selectedIndex < 0 ?
             document.activeElement :
             this.previews.item(this._selectedIndex);
  },
  get isOpen() {
    return this.panel.state == "open" || this.panel.state == "showing" || this._timer;
  },
  get tabCount() {
    return this.tabList.length;
  },
  get tabPreviewCount() {
    return Math.min(this.maxTabPreviews, this.tabCount);
  },

  get tabList() {
    return this._recentlyUsedTabs;
  },

  init: function ctrlTab_init() {
    if (!this._recentlyUsedTabs) {
      this._initRecentlyUsedTabs();
      this._init(true);
    }
  },

  uninit: function ctrlTab_uninit() {
    if (this._recentlyUsedTabs) {
      this._recentlyUsedTabs = null;
      this._init(false);
    }
  },

  prefName: "browser.ctrlTab.recentlyUsedOrder",
  readPref: function ctrlTab_readPref() {
    var enable =
      Services.prefs.getBoolPref(this.prefName) &&
      !Services.prefs.getBoolPref("browser.ctrlTab.disallowForScreenReaders", false);

    if (enable)
      this.init();
    else
      this.uninit();
  },
  observe(aSubject, aTopic, aPrefName) {
    this.readPref();
  },

  makePreview: function ctrlTab_makePreview(aIsShowAllButton) {
    let preview = document.createXULElement("button");
    preview.setAttribute("class", "ctrlTab-preview");
    preview.setAttribute("pack", "center");
    if (!aIsShowAllButton) {
      preview.setAttribute("flex", "1");
    }
    preview.addEventListener("mouseover", () => this._mouseOverFocus(preview));
    preview.addEventListener("command", () => this.pick(preview));
    preview.addEventListener("click", event => {
      if (event.button == 1) {
        this.remove(preview);
      } else if (AppConstants.platform == "macosx" && event.button == 2) {
        // Control+click is a right click on OS X
        this.pick(preview);
      }
    });

    let previewInner = document.createXULElement("vbox");
    previewInner.setAttribute("class", "ctrlTab-preview-inner");
    preview.appendChild(previewInner);

    if (!aIsShowAllButton) {
      let canvasWidth = this.canvasWidth;
      let canvasHeight = this.canvasHeight;

      let canvas = preview._canvas = document.createXULElement("hbox");
      canvas.setAttribute("class", "ctrlTab-canvas");
      canvas.setAttribute("width", canvasWidth);
      canvas.style.minWidth = canvasWidth + "px";
      canvas.style.maxWidth = canvasWidth + "px";
      canvas.style.minHeight = canvasHeight + "px";
      canvas.style.maxHeight = canvasHeight + "px";
      previewInner.appendChild(canvas);

      let faviconContainer = document.createXULElement("hbox");
      faviconContainer.setAttribute("class", "ctrlTab-favicon-container");
      previewInner.appendChild(faviconContainer);

      let favicon = preview._favicon = document.createXULElement("image");
      favicon.setAttribute("class", "ctrlTab-favicon");
      faviconContainer.appendChild(favicon);
    }

    let label = preview._label = document.createXULElement("label");
    label.setAttribute("class", "ctrlTab-label plain");
    label.setAttribute("crop", "end");
    previewInner.appendChild(label);

    return preview;
  },

  updatePreviews: function ctrlTab_updatePreviews() {
    for (let i = 0; i < this.previews.length; i++)
      this.updatePreview(this.previews[i], this.tabList[i]);

    var showAllLabel = gNavigatorBundle.getString("ctrlTab.listAllTabs.label");
    this.showAllButton._label.setAttribute("value",
      PluralForm.get(this.tabCount, showAllLabel).replace("#1", this.tabCount));
    this.showAllButton.hidden = !gTabsPanel.canOpen;
  },

  updatePreview: function ctrlTab_updatePreview(aPreview, aTab) {
    if (aPreview == this.showAllButton)
      return;

    aPreview._tab = aTab;

    if (aPreview._canvas.firstElementChild) {
      aPreview._canvas.firstElementChild.remove();
    }

    if (aTab) {
      aPreview._canvas.appendChild(tabPreviews.get(aTab));
      aPreview._label.setAttribute("value", aTab.label);
      aPreview.setAttribute("tooltiptext", aTab.label);
      if (aTab.image) {
        aPreview._favicon.setAttribute("src", aTab.image);
      } else {
        aPreview._favicon.removeAttribute("src");
      }
      aPreview.hidden = false;
    } else {
      aPreview.hidden = true;
      aPreview._label.removeAttribute("value");
      aPreview.removeAttribute("tooltiptext");
      aPreview._favicon.removeAttribute("src");
    }
  },

  advanceFocus: function ctrlTab_advanceFocus(aForward) {
    let selectedIndex = Array.indexOf(this.previews, this.selected);
    do {
      selectedIndex += aForward ? 1 : -1;
      if (selectedIndex < 0)
        selectedIndex = this.previews.length - 1;
      else if (selectedIndex >= this.previews.length)
        selectedIndex = 0;
    } while (this.previews[selectedIndex].hidden);

    if (this._selectedIndex == -1) {
      // Focus is already in the panel.
      this.previews[selectedIndex].focus();
    } else {
      this._selectedIndex = selectedIndex;
    }

    if (this.previews[selectedIndex]._tab) {
      gBrowser.warmupTab(this.previews[selectedIndex]._tab);
    }

    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
      this._openPanel();
    }
  },

  _mouseOverFocus: function ctrlTab_mouseOverFocus(aPreview) {
    if (this._trackMouseOver)
      aPreview.focus();
  },

  pick: function ctrlTab_pick(aPreview) {
    if (!this.tabCount)
      return;

    var select = (aPreview || this.selected);

    if (select == this.showAllButton)
      this.showAllTabs();
    else
      this.close(select._tab);
  },

  showAllTabs: function ctrlTab_showAllTabs(aPreview) {
    this.close();
    document.getElementById("Browser:ShowAllTabs").doCommand();
  },

  remove: function ctrlTab_remove(aPreview) {
    if (aPreview._tab)
      gBrowser.removeTab(aPreview._tab);
  },

  attachTab: function ctrlTab_attachTab(aTab, aPos) {
    if (aTab.closing)
      return;

    if (aPos == 0)
      this._recentlyUsedTabs.unshift(aTab);
    else if (aPos)
      this._recentlyUsedTabs.splice(aPos, 0, aTab);
    else
      this._recentlyUsedTabs.push(aTab);
  },

  detachTab: function ctrlTab_detachTab(aTab) {
    var i = this._recentlyUsedTabs.indexOf(aTab);
    if (i >= 0)
      this._recentlyUsedTabs.splice(i, 1);
  },

  open: function ctrlTab_open() {
    if (this.isOpen)
      return;

    document.addEventListener("keyup", this, true);

    this.updatePreviews();
    this._selectedIndex = 1;
    gBrowser.warmupTab(this.selected._tab);

    // Add a slight delay before showing the UI, so that a quick
    // "ctrl-tab" keypress just flips back to the MRU tab.
    this._timer = setTimeout(function(self) {
      self._timer = null;
      self._openPanel();
    }, 200, this);
  },

  _openPanel: function ctrlTab_openPanel() {
    tabPreviewPanelHelper.opening(this);

    this.panel.width = Math.min(screen.availWidth * .99,
                                this.canvasWidth * 1.25 * this.tabPreviewCount);
    var estimateHeight = this.canvasHeight * 1.25 + 75;
    this.panel.openPopupAtScreen(screen.availLeft + (screen.availWidth - this.panel.width) / 2,
                                 screen.availTop + (screen.availHeight - estimateHeight) / 2,
                                 false);
  },

  close: function ctrlTab_close(aTabToSelect) {
    if (!this.isOpen)
      return;

    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
      this.suspendGUI();
      if (aTabToSelect)
        gBrowser.selectedTab = aTabToSelect;
      return;
    }

    this.tabToSelect = aTabToSelect;
    this.panel.hidePopup();
  },

  setupGUI: function ctrlTab_setupGUI() {
    this.selected.focus();
    this._selectedIndex = -1;

    // Track mouse movement after a brief delay so that the item that happens
    // to be under the mouse pointer initially won't be selected unintentionally.
    this._trackMouseOver = false;
    setTimeout(function(self) {
      if (self.isOpen)
        self._trackMouseOver = true;
    }, 0, this);
  },

  suspendGUI: function ctrlTab_suspendGUI() {
    document.removeEventListener("keyup", this, true);

    for (let preview of this.previews) {
      this.updatePreview(preview, null);
    }
  },

  onKeyDown(event) {
    if (event.keyCode != event.DOM_VK_TAB ||
        !event.ctrlKey ||
        event.altKey ||
        event.metaKey) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (this.isOpen) {
      this.advanceFocus(!event.shiftKey);
    } else if (!event.shiftKey) {
      let tabs = gBrowser.visibleTabs;
      if (tabs.length > 2) {
        this.open();
      } else if (tabs.length == 2) {
        let index = tabs[0].selected ? 1 : 0;
        gBrowser.selectedTab = tabs[index];
      }
    }
  },

  onKeyPress(event) {
    if (!this.isOpen ||
        !event.ctrlKey) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.keyCode == event.DOM_VK_DELETE) {
      this.remove(this.selected);
      return;
    }

    switch (event.charCode) {
      case this.keys.close:
        this.remove(this.selected);
        break;
      case this.keys.find:
      case this.keys.selectAll:
        this.showAllTabs();
        break;
    }
  },

  removeClosingTabFromUI: function ctrlTab_removeClosingTabFromUI(aTab) {
    if (this.tabCount == 2) {
      this.close();
      return;
    }

    this.updatePreviews();

    if (this.selected.hidden)
      this.advanceFocus(false);
    if (this.selected == this.showAllButton)
      this.advanceFocus(false);

    // If the current tab is removed, another tab can steal our focus.
    if (aTab.selected && this.panel.state == "open") {
      setTimeout(function(selected) {
        selected.focus();
      }, 0, this.selected);
    }
  },

  handleEvent: function ctrlTab_handleEvent(event) {
    switch (event.type) {
      case "SSWindowRestored":
        this._initRecentlyUsedTabs();
        break;
      case "TabAttrModified":
        // tab attribute modified (i.e. label, busy, image)
        // update preview only if tab attribute modified in the list
        if (event.detail.changed.some(
          (elem, ind, arr) => ["label", "busy", "image"].includes(elem))) {
          for (let i = this.previews.length - 1; i >= 0; i--) {
            if (this.previews[i]._tab && this.previews[i]._tab == event.target) {
              this.updatePreview(this.previews[i], event.target);
              break;
            }
          }
        }
        break;
      case "TabSelect":
        this.detachTab(event.target);
        this.attachTab(event.target, 0);
        break;
      case "TabOpen":
        this.attachTab(event.target, 1);
        break;
      case "TabClose":
        this.detachTab(event.target);
        if (this.isOpen)
          this.removeClosingTabFromUI(event.target);
        break;
      case "keydown":
        this.onKeyDown(event);
        break;
      case "keypress":
        this.onKeyPress(event);
        break;
      case "keyup":
        if (event.keyCode == event.DOM_VK_CONTROL)
          this.pick();
        break;
      case "popupshowing":
        if (event.target.id == "menu_viewPopup")
          document.getElementById("menu_showAllTabs").hidden = !gTabsPanel.canOpen;
        break;
    }
  },

  filterForThumbnailExpiration(aCallback) {
    // Save a few more thumbnails than we actually display, so that when tabs
    // are closed, the previews we add instead still get thumbnails.
    const extraThumbnails = 3;
    const thumbnailCount = Math.min(this.tabPreviewCount + extraThumbnails,
                                    this.tabCount);

    let urls = [];
    for (let i = 0; i < thumbnailCount; i++)
      urls.push(this.tabList[i].linkedBrowser.currentURI.spec);

    aCallback(urls);
  },

  _initRecentlyUsedTabs() {
    this._recentlyUsedTabs =
      Array.filter(gBrowser.tabs, tab => !tab.closing)
           .sort((tab1, tab2) => tab2.lastAccessed - tab1.lastAccessed);
  },

  _init: function ctrlTab__init(enable) {
    var toggleEventListener = enable ? "addEventListener" : "removeEventListener";

    window[toggleEventListener]("SSWindowRestored", this);

    var tabContainer = gBrowser.tabContainer;
    tabContainer[toggleEventListener]("TabOpen", this);
    tabContainer[toggleEventListener]("TabAttrModified", this);
    tabContainer[toggleEventListener]("TabSelect", this);
    tabContainer[toggleEventListener]("TabClose", this);

    if (enable) {
      Services.els.addSystemEventListener(document, "keydown", this, false);
    } else {
      Services.els.removeSystemEventListener(document, "keydown", this, false);
    }
    document[toggleEventListener]("keypress", this);
    gBrowser.tabbox.handleCtrlTab = !enable;

    if (enable)
      PageThumbs.addExpirationFilter(this);
    else
      PageThumbs.removeExpirationFilter(this);

    // If we're not running, hide the "Show All Tabs" menu item,
    // as Shift+Ctrl+Tab will be handled by the tab bar.
    document.getElementById("menu_showAllTabs").hidden = !enable;
    document.getElementById("menu_viewPopup")[toggleEventListener]("popupshowing", this);

    // Also disable the <key> to ensure Shift+Ctrl+Tab never triggers
    // Show All Tabs.
    var key_showAllTabs = document.getElementById("key_showAllTabs");
    if (enable)
      key_showAllTabs.removeAttribute("disabled");
    else
      key_showAllTabs.setAttribute("disabled", "true");
  }
};
