/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { AddonManager } = require("resource://gre/modules/AddonManager.jsm");
const { BrowserToolboxProcess } =
  require("resource://devtools/client/framework/ToolboxProcess.jsm");
const { Cc, Ci } = require("chrome");
const { DebuggerClient } = require("devtools/shared/client/debugger-client");
const { DebuggerServer } = require("devtools/server/main");
const { gDevToolsBrowser } = require("devtools/client/framework/devtools-browser");

const {
  CONNECT_RUNTIME_FAILURE,
  CONNECT_RUNTIME_START,
  CONNECT_RUNTIME_SUCCESS,
  DEBUG_TARGETS,
  DISCONNECT_RUNTIME_FAILURE,
  DISCONNECT_RUNTIME_START,
  DISCONNECT_RUNTIME_SUCCESS,
  REQUEST_EXTENSIONS_FAILURE,
  REQUEST_EXTENSIONS_START,
  REQUEST_EXTENSIONS_SUCCESS,
  REQUEST_TABS_FAILURE,
  REQUEST_TABS_START,
  REQUEST_TABS_SUCCESS,
  REQUEST_WORKERS_FAILURE,
  REQUEST_WORKERS_START,
  REQUEST_WORKERS_SUCCESS,
} = require("../constants");

let browserToolboxProcess = null;

function connectRuntime() {
  return async (dispatch, getState) => {
    dispatch({ type: CONNECT_RUNTIME_START });

    DebuggerServer.init();
    DebuggerServer.registerAllActors();
    const client = new DebuggerClient(DebuggerServer.connectPipe());

    try {
      await client.connect();

      dispatch({ type: CONNECT_RUNTIME_SUCCESS, client });
      dispatch(requestExtensions());
      dispatch(requestTabs());
      dispatch(requestWorkers());
    } catch (e) {
      dispatch({ type: CONNECT_RUNTIME_FAILURE, error: e.message });
    }
  };
}

function disconnectRuntime() {
  return async (dispatch, getState) => {
    dispatch({ type: DISCONNECT_RUNTIME_START });

    const client = getState().runtime.client;

    try {
      await client.close();
      DebuggerServer.destroy();

      dispatch({ type: DISCONNECT_RUNTIME_SUCCESS });
    } catch (e) {
      dispatch({ type: DISCONNECT_RUNTIME_FAILURE, error: e.message });
    }
  };
}

function inspectDebugTarget(type, id) {
  return async (_, getState) => {
    switch (type) {
      case DEBUG_TARGETS.TAB: {
        // Open tab debugger in new window.
        window.open(`about:devtools-toolbox?type=tab&id=${ id }`);
        break;
      }
      case DEBUG_TARGETS.EXTENSION: {
        // Close current debugging toolbox and open a new one.
        if (browserToolboxProcess) {
          browserToolboxProcess.close();
        }

        browserToolboxProcess = BrowserToolboxProcess.init({
          addonID: id,
          onClose: () => {
            browserToolboxProcess = null;
          }
        });
        break;
      }
      case DEBUG_TARGETS.WORKER: {
        // Open worker toolbox in new window.
        gDevToolsBrowser.openWorkerToolbox(getState().runtime.client, id);
        break;
      }

      default: {
        console.error("Failed to inspect the debug target of " +
                      `type: ${ type } id: ${ id }`);
      }
    }
  };
}

function installTemporaryExtension() {
  const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
  fp.init(window, "Select Manifest File or Package (.xpi)", Ci.nsIFilePicker.modeOpen);
  fp.open(async res => {
    if (res == Ci.nsIFilePicker.returnCancel || !fp.file) {
      return;
    }

    let file = fp.file;

    // AddonManager.installTemporaryAddon accepts either
    // addon directory or final xpi file.
    if (!file.isDirectory() &&
        !file.leafName.endsWith(".xpi") && !file.leafName.endsWith(".zip")) {
      file = file.parent;
    }

    try {
      await AddonManager.installTemporaryAddon(file);
    } catch (e) {
      console.error(e);
    }
  });

  return () => {};
}

function pushServiceWorker(actor) {
  return async (_, getState) => {
    const client = getState().runtime.client;

    try {
      await client.request({ to: actor, type: "push" });
    } catch (e) {
      console.error(e);
    }
  };
}

function reloadTemporaryExtension(actor) {
  return async (_, getState) => {
    const client = getState().runtime.client;

    try {
      await client.request({ to: actor, type: "reload" });
    } catch (e) {
      console.error(e);
    }
  };
}

function removeTemporaryExtension(id) {
  return async () => {
    try {
      const addon = await AddonManager.getAddonByID(id);

      if (addon) {
        await addon.uninstall();
      }
    } catch (e) {
      console.error(e);
    }
  };
}

function requestTabs() {
  return async (dispatch, getState) => {
    dispatch({ type: REQUEST_TABS_START });

    const client = getState().runtime.client;

    try {
      const { tabs } = await client.listTabs({ favicons: true });

      dispatch({ type: REQUEST_TABS_SUCCESS, tabs });
    } catch (e) {
      dispatch({ type: REQUEST_TABS_FAILURE, error: e.message });
    }
  };
}

function requestExtensions() {
  return async (dispatch, getState) => {
    dispatch({ type: REQUEST_EXTENSIONS_START });

    const client = getState().runtime.client;

    try {
      const { addons } = await client.listAddons();
      const extensions = addons.filter(a => a.debuggable);
      const installedExtensions = extensions.filter(e => !e.temporarilyInstalled);
      const temporaryExtensions = extensions.filter(e => e.temporarilyInstalled);

      dispatch({
        type: REQUEST_EXTENSIONS_SUCCESS,
        installedExtensions,
        temporaryExtensions,
      });
    } catch (e) {
      dispatch({ type: REQUEST_EXTENSIONS_FAILURE, error: e.message });
    }
  };
}

function requestWorkers() {
  return async (dispatch, getState) => {
    dispatch({ type: REQUEST_WORKERS_START });

    const client = getState().runtime.client;

    try {
      const {
        other: otherWorkers,
        service: serviceWorkers,
        shared: sharedWorkers,
      } = await client.mainRoot.listAllWorkers();

      dispatch({
        type: REQUEST_WORKERS_SUCCESS,
        otherWorkers,
        serviceWorkers,
        sharedWorkers,
      });
    } catch (e) {
      dispatch({ type: REQUEST_WORKERS_FAILURE, error: e.message });
    }
  };
}

function startServiceWorker(actor) {
  return async (_, getState) => {
    const client = getState().runtime.client;

    try {
      await client.request({ to: actor, type: "start" });
    } catch (e) {
      console.error(e);
    }
  };
}

module.exports = {
  connectRuntime,
  disconnectRuntime,
  inspectDebugTarget,
  installTemporaryExtension,
  pushServiceWorker,
  reloadTemporaryExtension,
  removeTemporaryExtension,
  requestTabs,
  requestExtensions,
  requestWorkers,
  startServiceWorker,
};
