/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { combineReducers } = require("devtools/client/shared/vendor/redux");
const { runtimeReducer } = require("./runtime-state");
const { uiReducer } = require("./ui-state");

module.exports = combineReducers({
  runtime: runtimeReducer,
  ui: uiReducer
});
