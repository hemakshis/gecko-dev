/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

ChromeUtils.import("resource://gre/modules/Messaging.jsm");

var EXPORTED_SYMBOLS = ["BrowserActions"];

var BrowserActions = {
  _browserActions: {},
  _browserActionTitles: {},

  _initialized: false,

  /**
   * Registers the listeners only if they have not been initialized
   * already and there is at least one browser action.
   */
  _maybeRegisterListeners() {
    if (!this._initialized && Object.keys(this._browserActions).length) {
      this._initialized = true;
      EventDispatcher.instance.registerListener(this, "Menu:Clicked");
    }
  },

  /**
   * Unregisters the listeners if they are already initizliaed and
   * all of the browser actions have been removed.
   */
  _maybeUnregisterListeners() {
    if (this._initialized && !Object.keys(this._browserActions).length) {
      this._initialized = false;
      EventDispatcher.instance.unregisterListener(this, "Menu:Clicked");
    }
  },

  /**
   * Called when a browser action is clicked on.
   * @param {string} event The name of the event, which should always
   *    be "Menu:Clicked".
   * @param {Object} data An object containing information about the
   *    browser action, which in this case should contain an `item`
   *    property which is browser action's UUID.
   */
  onEvent(event, data) {
    if (event !== "Menu:Clicked") {
      throw new Error(`Expected "Menu:Clicked" event - received "${event}" instead`);
    }

    let browserAction = this._browserActions[data.item];
    if (!browserAction) {
      // This was probably meant for the NativeWindow menu handler.
      return;
    }
    browserAction.onClicked();
  },

  /**
   * Registers a new browser action.
   * @param {Object} browserAction The browser action to add.
   */
  register(browserAction) {
    EventDispatcher.instance.sendRequest({
      type: "Menu:Add",
      uuid: browserAction.uuid,
      name: browserAction.defaults.name,
    });

    this._browserActions[browserAction.uuid] = browserAction;
    this._browserActionTitles[browserAction.uuid] = browserAction.defaults.name;

    this._maybeRegisterListeners();
  },

  /**
   * Updates the browser action with the specified UUID.
   * @param {string} uuid The UUID of the browser action.
   * @param {Object} options The properties to update.
   */
  update(uuid, options) {
    if (options.name) {
      EventDispatcher.instance.sendRequest({
        type: "Menu:Update",
        uuid,
        options,
      });

      this._browserActionTitles[uuid] = options.name;
    }
  },

  /**
   * Retrieves the name currently used for the browser action with the
   * specified UUID. Used for testing only.
   * @param {string} uuid The UUID of the browser action.
   * @returns {string} the name currently used for the browser action.
   */
  getNameForActiveTab(uuid) {
    return this._browserActionTitles[uuid];
  },

  /**
   * Checks to see if the browser action is shown. Used for testing only.
   * @param {string} uuid The UUID of the browser action.
   * @returns {boolean} true if the browser action is shown; false otherwise.
   */
  isShown(uuid) {
    return !!this._browserActions[uuid];
  },

  /**
   * Synthesizes a click on the browser action. Used for testing only.
   * @param {string} uuid The UUID of the browser action.
   */
  synthesizeClick(uuid) {
    let browserAction = this._browserActions[uuid];
    if (!browserAction) {
      throw new Error(`No BrowserAction with UUID ${uuid} was found`);
    }
    browserAction.onClicked();
  },

  /**
   * Unregisters the browser action with the specified UUID.
   * @param {string} uuid The UUID of the browser action.
   */
  unregister(uuid) {
    let browserAction = this._browserActions[uuid];
    if (!browserAction) {
      throw new Error(`No BrowserAction with UUID ${uuid} was found`);
    }
    EventDispatcher.instance.sendRequest({
      type: "Menu:Remove",
      uuid,
    });
    delete this._browserActions[uuid];
    delete this._browserActionTitles[uuid];
    this._maybeUnregisterListeners();
  }
};
