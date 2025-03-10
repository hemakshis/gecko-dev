// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/* import-globals-from in-content/main.js */

var gAppManagerDialog = {
  _removed: [],

  onLoad() {
    document.mozSubdialogReady = this.init();
  },

  async init() {
    this.handlerInfo = window.arguments[0];
    Services.scriptloader.loadSubScript("chrome://browser/content/preferences/in-content/main.js",
      window);

    const appDescElem = document.getElementById("appDescription");
    if (this.handlerInfo.type == TYPE_MAYBE_FEED) {
      document.l10n.setAttributes(appDescElem, "app-manager-handle-webfeeds");
    } else if (this.handlerInfo.wrappedHandlerInfo instanceof Ci.nsIMIMEInfo) {
      document.l10n.setAttributes(appDescElem, "app-manager-handle-file", {
        type: this.handlerInfo.typeDescription,
      });
    } else {
      document.l10n.setAttributes(appDescElem, "app-manager-handle-protocol", {
        type: this.handlerInfo.typeDescription,
      });
    }

    var list = document.getElementById("appList");
    for (let app of this.handlerInfo.possibleApplicationHandlers.enumerate()) {
      if (!gMainPane.isValidHandlerApp(app))
        continue;

      // Ensure the XBL binding is created eagerly.
      // eslint-disable-next-line no-undef
      list.appendChild(MozXULElement.parseXULToFragment("<richlistitem/>"));
      var item = list.lastChild;
      item.app = app;

      var image = document.createXULElement("image");
      image.setAttribute("src", gMainPane._getIconURLForHandlerApp(app));
      item.appendChild(image);

      var label = document.createXULElement("label");
      label.setAttribute("value", app.name);
      item.appendChild(label);
    }

    // Triggers onSelect which populates label
    list.selectedIndex = 0;

    // We want to block on those elements being localized because the
    // result will impact the size of the subdialog.
    await document.l10n.translateElements([
      appDescElem,
      document.getElementById("appType")
    ]);
  },

  onOK: function appManager_onOK() {
    if (!this._removed.length) {
      // return early to avoid calling the |store| method.
      return;
    }

    for (var i = 0; i < this._removed.length; ++i)
      this.handlerInfo.removePossibleApplicationHandler(this._removed[i]);

    this.handlerInfo.store();
  },

  onCancel: function appManager_onCancel() {
    // do nothing
  },

  remove: function appManager_remove() {
    var list = document.getElementById("appList");
    this._removed.push(list.selectedItem.app);
    var index = list.selectedIndex;
    var element = list.selectedItem;
    list.removeItemFromSelection(element);
    element.remove();
    if (list.itemCount == 0) {
      // The list is now empty, make the bottom part disappear
      document.getElementById("appDetails").hidden = true;
    } else {
      // Select the item at the same index, if we removed the last
      // item of the list, select the previous item
      if (index == list.itemCount)
        --index;
      list.selectedIndex = index;
    }
  },

  onSelect: function appManager_onSelect() {
    var list = document.getElementById("appList");
    if (!list.selectedItem) {
      document.getElementById("remove").disabled = true;
      return;
    }
    document.getElementById("remove").disabled = false;
    var app = list.selectedItem.app;
    var address = "";
    if (app instanceof Ci.nsILocalHandlerApp)
      address = app.executable.path;
    else if (app instanceof Ci.nsIWebHandlerApp)
      address = app.uriTemplate;
    document.getElementById("appLocation").value = address;
    const l10nId = app instanceof Ci.nsILocalHandlerApp ? "app-manager-local-app-info"
                                                        : "app-manager-web-app-info";
    const appTypeElem = document.getElementById("appType");
    document.l10n.setAttributes(appTypeElem, l10nId);
  }
};
