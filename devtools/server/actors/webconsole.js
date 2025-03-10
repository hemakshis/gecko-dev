/* -*- js-indent-level: 2; indent-tabs-mode: nil -*- */
/* vim: set ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* global XPCNativeWrapper evalWithDebugger */

const Services = require("Services");
const { Cc, Ci, Cu } = require("chrome");
const { DebuggerServer } = require("devtools/server/main");
const { ActorPool } = require("devtools/server/actors/common");
const { ThreadActor } = require("devtools/server/actors/thread");
const { ObjectActor } = require("devtools/server/actors/object");
const { LongStringActor } = require("devtools/server/actors/object/long-string");
const { createValueGrip, stringIsLong } = require("devtools/server/actors/object/utils");
const DevToolsUtils = require("devtools/shared/DevToolsUtils");
const ErrorDocs = require("devtools/server/actors/errordocs");
const { evalWithDebugger } = require("devtools/server/actors/webconsole/eval-with-debugger");

loader.lazyRequireGetter(this, "NetworkMonitorActor", "devtools/server/actors/network-monitor", true);
loader.lazyRequireGetter(this, "ConsoleProgressListener", "devtools/server/actors/webconsole/listeners/console-progress", true);
loader.lazyRequireGetter(this, "StackTraceCollector", "devtools/server/actors/network-monitor/stack-trace-collector", true);
loader.lazyRequireGetter(this, "JSPropertyProvider", "devtools/shared/webconsole/js-property-provider", true);
loader.lazyRequireGetter(this, "NetUtil", "resource://gre/modules/NetUtil.jsm", true);
loader.lazyRequireGetter(this, "addWebConsoleCommands", "devtools/server/actors/webconsole/utils", true);
loader.lazyRequireGetter(this, "isCommand", "devtools/server/actors/webconsole/commands", true);
loader.lazyRequireGetter(this, "validCommands", "devtools/server/actors/webconsole/commands", true);
loader.lazyRequireGetter(this, "createMessageManagerMocks", "devtools/server/actors/webconsole/message-manager-mock", true);
loader.lazyRequireGetter(this, "CONSOLE_WORKER_IDS", "devtools/server/actors/webconsole/utils", true);
loader.lazyRequireGetter(this, "WebConsoleUtils", "devtools/server/actors/webconsole/utils", true);
loader.lazyRequireGetter(this, "EnvironmentActor", "devtools/server/actors/environment", true);
loader.lazyRequireGetter(this, "EventEmitter", "devtools/shared/event-emitter");

// Overwrite implemented listeners for workers so that we don't attempt
// to load an unsupported module.
if (isWorker) {
  loader.lazyRequireGetter(this, "ConsoleAPIListener", "devtools/server/actors/webconsole/worker-listeners", true);
  loader.lazyRequireGetter(this, "ConsoleServiceListener", "devtools/server/actors/webconsole/worker-listeners", true);
} else {
  loader.lazyRequireGetter(this, "ConsoleAPIListener", "devtools/server/actors/webconsole/listeners/console-api", true);
  loader.lazyRequireGetter(this, "ConsoleServiceListener", "devtools/server/actors/webconsole/listeners/console-service", true);
  loader.lazyRequireGetter(this, "ConsoleReflowListener", "devtools/server/actors/webconsole/listeners/console-reflow", true);
  loader.lazyRequireGetter(this, "ContentProcessListener", "devtools/server/actors/webconsole/listeners/content-process", true);
  loader.lazyRequireGetter(this, "DocumentEventsListener", "devtools/server/actors/webconsole/listeners/document-events", true);
}

function isObject(value) {
  return Object(value) === value;
}

/**
 * The WebConsoleActor implements capabilities needed for the Web Console
 * feature.
 *
 * @constructor
 * @param object connection
 *        The connection to the client, DebuggerServerConnection.
 * @param object [parentActor]
 *        Optional, the parent actor.
 */
function WebConsoleActor(connection, parentActor) {
  this.conn = connection;
  this.parentActor = parentActor;

  this._actorPool = new ActorPool(this.conn);
  this.conn.addActorPool(this._actorPool);

  this._prefs = {};

  this.dbg = this.parentActor.makeDebugger();

  this._gripDepth = 0;
  this._listeners = new Set();
  this._lastConsoleInputEvaluation = undefined;

  this.objectGrip = this.objectGrip.bind(this);
  this._onWillNavigate = this._onWillNavigate.bind(this);
  this._onChangedToplevelDocument = this._onChangedToplevelDocument.bind(this);
  EventEmitter.on(this.parentActor, "changed-toplevel-document",
            this._onChangedToplevelDocument);
  this._onObserverNotification = this._onObserverNotification.bind(this);
  if (this.parentActor.isRootActor) {
    Services.obs.addObserver(this._onObserverNotification,
                             "last-pb-context-exited");
  }

  this.traits = {
    evaluateJSAsync: true,
    transferredResponseSize: true,
    selectedObjectActor: true, // 44+
    fetchCacheDescriptor: true,
  };

  if (this.dbg.replaying && !isWorker) {
    this.dbg.onConsoleMessage = this.onReplayingMessage.bind(this);
  }
}

WebConsoleActor.prototype =
{
  /**
   * Debugger instance.
   *
   * @see jsdebugger.jsm
   */
  dbg: null,

  /**
   * This is used by the ObjectActor to keep track of the depth of grip() calls.
   * @private
   * @type number
   */
  _gripDepth: null,

  /**
   * Actor pool for all of the actors we send to the client.
   * @private
   * @type object
   * @see ActorPool
   */
  _actorPool: null,

  /**
   * Web Console-related preferences.
   * @private
   * @type object
   */
  _prefs: null,

  /**
   * Holds a set of all currently registered listeners.
   *
   * @private
   * @type Set
   */
  _listeners: null,

  /**
   * The debugger server connection instance.
   * @type object
   */
  conn: null,

  /**
   * List of supported features by the console actor.
   * @type object
   */
  traits: null,

  /**
   * The window or sandbox we work with.
   * Note that even if it is named `window` it refers to the current
   * global we are debugging, which can be a Sandbox for addons
   * or browser content toolbox.
   *
   * @type nsIDOMWindow or Sandbox
   */
  get window() {
    if (this.parentActor.isRootActor) {
      return this._getWindowForBrowserConsole();
    }
    return this.parentActor.window;
  },

  /**
   * Get a window to use for the browser console.
   *
   * @private
   * @return nsIDOMWindow
   *         The window to use, or null if no window could be found.
   */
  _getWindowForBrowserConsole: function() {
    // Check if our last used chrome window is still live.
    let window = this._lastChromeWindow && this._lastChromeWindow.get();
    // If not, look for a new one.
    if (!window || window.closed) {
      window = this.parentActor.window;
      if (!window) {
        // Try to find the Browser Console window to use instead.
        window = Services.wm.getMostRecentWindow("devtools:webconsole");
        // We prefer the normal chrome window over the console window,
        // so we'll look for those windows in order to replace our reference.
        const onChromeWindowOpened = () => {
          // We'll look for this window when someone next requests window()
          Services.obs.removeObserver(onChromeWindowOpened, "domwindowopened");
          this._lastChromeWindow = null;
        };
        Services.obs.addObserver(onChromeWindowOpened, "domwindowopened");
      }

      this._handleNewWindow(window);
    }

    return window;
  },

  /**
   * Store a newly found window on the actor to be used in the future.
   *
   * @private
   * @param nsIDOMWindow window
   *        The window to store on the actor (can be null).
   */
  _handleNewWindow: function(window) {
    if (window) {
      if (this._hadChromeWindow) {
        Services.console.logStringMessage("Webconsole context has changed");
      }
      this._lastChromeWindow = Cu.getWeakReference(window);
      this._hadChromeWindow = true;
    } else {
      this._lastChromeWindow = null;
    }
  },

  /**
   * Whether we've been using a window before.
   *
   * @private
   * @type boolean
   */
  _hadChromeWindow: false,

  /**
   * A weak reference to the last chrome window we used to work with.
   *
   * @private
   * @type nsIWeakReference
   */
  _lastChromeWindow: null,

  // The evalWindow is used at the scope for JS evaluation.
  _evalWindow: null,
  get evalWindow() {
    return this._evalWindow || this.window;
  },

  set evalWindow(window) {
    this._evalWindow = window;

    if (!this._progressListenerActive) {
      EventEmitter.on(this.parentActor, "will-navigate", this._onWillNavigate);
      this._progressListenerActive = true;
    }
  },

  /**
   * Flag used to track if we are listening for events from the progress
   * listener of the target actor. We use the progress listener to clear
   * this.evalWindow on page navigation.
   *
   * @private
   * @type boolean
   */
  _progressListenerActive: false,

  /**
   * The ConsoleServiceListener instance.
   * @type object
   */
  consoleServiceListener: null,

  /**
   * The ConsoleAPIListener instance.
   */
  consoleAPIListener: null,

  /**
   * The ConsoleProgressListener instance.
   */
  consoleProgressListener: null,

  /**
   * The ConsoleReflowListener instance.
   */
  consoleReflowListener: null,

  /**
   * The Web Console Commands names cache.
   * @private
   * @type array
   */
  _webConsoleCommandsCache: null,

  typeName: "console",

  get globalDebugObject() {
    return this.parentActor.threadActor.globalDebugObject;
  },

  grip: function() {
    return { actor: this.actorID };
  },

  hasNativeConsoleAPI: function(window) {
    if (isWorker) {
      // Can't use XPCNativeWrapper as a way to check for console API in workers
      return true;
    }

    let isNative = false;
    try {
      // We are very explicitly examining the "console" property of
      // the non-Xrayed object here.
      const console = window.wrappedJSObject.console;
      isNative = new XPCNativeWrapper(console).IS_NATIVE_CONSOLE;
    } catch (ex) {
      // ignored
    }
    return isNative;
  },

  _findProtoChain: ThreadActor.prototype._findProtoChain,
  _removeFromProtoChain: ThreadActor.prototype._removeFromProtoChain,

  /**
   * Destroy the current WebConsoleActor instance.
   */
  destroy() {
    if (this.consoleServiceListener) {
      this.consoleServiceListener.destroy();
      this.consoleServiceListener = null;
    }
    if (this.netmonitors) {
      for (const { messageManager } of this.netmonitors) {
        messageManager.sendAsyncMessage("debug:destroy-network-monitor", {
          actorID: this.actorID
        });
      }
      this.netmonitors = null;
    }
    if (this.consoleAPIListener) {
      this.consoleAPIListener.destroy();
      this.consoleAPIListener = null;
    }
    if (this.stackTraceCollector) {
      this.stackTraceCollector.destroy();
      this.stackTraceCollector = null;
    }
    if (this.consoleProgressListener) {
      this.consoleProgressListener.destroy();
      this.consoleProgressListener = null;
    }
    if (this.consoleReflowListener) {
      this.consoleReflowListener.destroy();
      this.consoleReflowListener = null;
    }
    if (this.contentProcessListener) {
      this.contentProcessListener.destroy();
      this.contentProcessListener = null;
    }

    EventEmitter.off(this.parentActor, "changed-toplevel-document",
               this._onChangedToplevelDocument);

    this.conn.removeActorPool(this._actorPool);

    if (this.parentActor.isRootActor) {
      Services.obs.removeObserver(this._onObserverNotification,
                                  "last-pb-context-exited");
    }

    this._actorPool = null;
    this._webConsoleCommandsCache = null;
    this._lastConsoleInputEvaluation = null;
    this._evalWindow = null;
    this.dbg.enabled = false;
    this.dbg = null;
    this.conn = null;
  },

  /**
   * Create and return an environment actor that corresponds to the provided
   * Debugger.Environment. This is a straightforward clone of the ThreadActor's
   * method except that it stores the environment actor in the web console
   * actor's pool.
   *
   * @param Debugger.Environment environment
   *        The lexical environment we want to extract.
   * @return The EnvironmentActor for |environment| or |undefined| for host
   *         functions or functions scoped to a non-debuggee global.
   */
  createEnvironmentActor: function(environment) {
    if (!environment) {
      return undefined;
    }

    if (environment.actor) {
      return environment.actor;
    }

    const actor = new EnvironmentActor(environment, this);
    this._actorPool.addActor(actor);
    environment.actor = actor;

    return actor;
  },

  /**
   * Create a grip for the given value.
   *
   * @param mixed value
   * @return object
   */
  createValueGrip: function(value) {
    return createValueGrip(value, this._actorPool, this.objectGrip);
  },

  /**
   * Make a debuggee value for the given value.
   *
   * @param mixed value
   *        The value you want to get a debuggee value for.
   * @param boolean useObjectGlobal
   *        If |true| the object global is determined and added as a debuggee,
   *        otherwise |this.window| is used when makeDebuggeeValue() is invoked.
   * @return object
   *         Debuggee value for |value|.
   */
  makeDebuggeeValue: function(value, useObjectGlobal) {
    if (this.dbg.replaying) {
      if (typeof value == "object") {
        throw new Error("Object makeDebuggeeValue not supported with replaying debugger");
      } else {
        return value;
      }
    }
    if (useObjectGlobal && isObject(value)) {
      try {
        const global = Cu.getGlobalForObject(value);
        const dbgGlobal = this.dbg.makeGlobalObjectReference(global);
        return dbgGlobal.makeDebuggeeValue(value);
      } catch (ex) {
        // The above can throw an exception if value is not an actual object
        // or 'Object in compartment marked as invisible to Debugger'
      }
    }
    const dbgGlobal = this.dbg.makeGlobalObjectReference(this.window);
    return dbgGlobal.makeDebuggeeValue(value);
  },

  /**
   * Create a grip for the given object.
   *
   * @param object object
   *        The object you want.
   * @param object pool
   *        An ActorPool where the new actor instance is added.
   * @param object
   *        The object grip.
   */
  objectGrip: function(object, pool) {
    const actor = new ObjectActor(object, {
      getGripDepth: () => this._gripDepth,
      incrementGripDepth: () => this._gripDepth++,
      decrementGripDepth: () => this._gripDepth--,
      createValueGrip: v => this.createValueGrip(v),
      sources: () => DevToolsUtils.reportException("WebConsoleActor",
        Error("sources not yet implemented")),
      createEnvironmentActor: (env) => this.createEnvironmentActor(env),
      getGlobalDebugObject: () => this.globalDebugObject
    }, this.conn);
    pool.addActor(actor);
    return actor.form();
  },

  /**
   * Create a grip for the given string.
   *
   * @param string string
   *        The string you want to create the grip for.
   * @param object pool
   *        An ActorPool where the new actor instance is added.
   * @return object
   *         A LongStringActor object that wraps the given string.
   */
  longStringGrip: function(string, pool) {
    const actor = new LongStringActor(string);
    pool.addActor(actor);
    return actor.grip();
  },

  /**
   * Create a long string grip if needed for the given string.
   *
   * @private
   * @param string string
   *        The string you want to create a long string grip for.
   * @return string|object
   *         A string is returned if |string| is not a long string.
   *         A LongStringActor grip is returned if |string| is a long string.
   */
  _createStringGrip: function(string) {
    if (string && stringIsLong(string)) {
      return this.longStringGrip(string, this._actorPool);
    }
    return string;
  },

  /**
   * Get an object actor by its ID.
   *
   * @param string actorID
   * @return object
   */
  getActorByID: function(actorID) {
    return this._actorPool.get(actorID);
  },

  /**
   * Release an actor.
   *
   * @param object actor
   *        The actor instance you want to release.
   */
  releaseActor: function(actor) {
    this._actorPool.removeActor(actor);
  },

  /**
   * Returns the latest web console input evaluation.
   * This is undefined if no evaluations have been completed.
   *
   * @return object
   */
  getLastConsoleInputEvaluation: function() {
    return this._lastConsoleInputEvaluation;
  },

  /**
   * This helper is used by the WebExtensionInspectedWindowActor to
   * inspect an object in the developer toolbox.
   */
  inspectObject(dbgObj, inspectFromAnnotation) {
    this.conn.sendActorEvent(this.actorID, "inspectObject", {
      objectActor: this.createValueGrip(dbgObj),
      inspectFromAnnotation,
    });
  },

  /**
   * When using a replaying debugger, all messages we have seen so far.
   */
  replayingMessages: null,

  /**
   * When using a replaying debugger, this helper returns whether a message has
   * been seen before. When the process rewinds or plays back through regions
   * of execution that have executed before, we will see the same messages
   * again.
   */
  isDuplicateReplayingMessage: function(msg) {
    if (!this.replayingMessages) {
      this.replayingMessages = {};
    }
    // The progress counter on the message is unique across all messages in the
    // replaying process.
    const progress = msg.executionPoint.progress;
    if (this.replayingMessages[progress]) {
      return true;
    }
    this.replayingMessages[progress] = true;
    return false;
  },

  // Request handlers for known packet types.

  /**
   * Handler for the "startListeners" request.
   *
   * @param object request
   *        The JSON request object received from the Web Console client.
   * @return object
   *         The response object which holds the startedListeners array.
   */
  startListeners: async function(request) {
    const startedListeners = [];
    const window = !this.parentActor.isRootActor ? this.window : null;

    while (request.listeners.length > 0) {
      const listener = request.listeners.shift();
      switch (listener) {
        case "PageError":
          // Workers don't support this message type yet
          if (isWorker) {
            break;
          }
          if (!this.consoleServiceListener) {
            this.consoleServiceListener =
              new ConsoleServiceListener(window, this);
            this.consoleServiceListener.init();
          }
          startedListeners.push(listener);
          break;
        case "ConsoleAPI":
          if (!this.consoleAPIListener) {
            // Create the consoleAPIListener
            // (and apply the filtering options defined in the parent actor).
            this.consoleAPIListener = new ConsoleAPIListener(
              window, this, this.parentActor.consoleAPIListenerOptions);
            this.consoleAPIListener.init();
          }
          startedListeners.push(listener);
          break;
        case "NetworkActivity":
          // Workers don't support this message type
          if (isWorker) {
            break;
          }
          if (!this.netmonitors) {
            // Instanciate fake message managers used for service worker's netmonitor
            // when running in the content process, and for netmonitor running in the
            // same process when running in the parent process.
            // `createMessageManagerMocks` returns a couple of connected messages
            // managers that pass messages to each other to simulate the process
            // boundary. We will use the first one for the webconsole-actor and the
            // second one will be used by the netmonitor-actor.
            const [ mmMockParent, mmMockChild ] = createMessageManagerMocks();

            // Maintain the list of message manager we should message to/listen from
            // to support the netmonitor instances, also records actorID of each
            // NetworkMonitorActor.
            // Array of `{ messageManager, parentProcess }`.
            // Where `parentProcess` is true for the netmonitor actor instanciated in the
            // parent process.
            this.netmonitors = [];

            // Check if the actor is running in a content process
            const isInContentProcess =
              Services.appinfo.processType != Ci.nsIXULRuntime.PROCESS_TYPE_DEFAULT &&
              this.parentActor.messageManager;
            if (isInContentProcess) {
              // Start a network monitor in the parent process to listen to
              // most requests that happen in parent. This one will communicate through
              // `messageManager`.
              await this.conn.spawnActorInParentProcess(
                this.actorID, {
                  module: "devtools/server/actors/network-monitor",
                  constructor: "NetworkMonitorActor",
                  args: [
                    { outerWindowID: this.parentActor.outerWindowID },
                    this.actorID
                  ],
                });
              this.netmonitors.push({
                messageManager: this.parentActor.messageManager,
                parentProcess: true
              });
            }

            // When the console actor runs in the parent process, Netmonitor can be ran
            // in the process and communicate through `messageManagerMock`.
            // And while it runs in the content process, we also spawn one in the content
            // to listen to requests that happen in the content process (for instance
            // service workers requests)
            new NetworkMonitorActor(this.conn,
              { window },
              this.actorID,
              mmMockParent);

            this.netmonitors.push({
              messageManager: mmMockChild,
              parentProcess: !isInContentProcess
            });

            // Create a StackTraceCollector that's going to be shared both by
            // the NetworkMonitorActor running in the same process for service worker
            // requests, as well with the NetworkMonitorActor running in the parent
            // process. It will communicate via message manager for this one.
            this.stackTraceCollector = new StackTraceCollector({ window },
              this.netmonitors);
            this.stackTraceCollector.init();
          }
          startedListeners.push(listener);
          break;
        case "FileActivity":
          // Workers don't support this message type
          if (isWorker) {
            break;
          }
          if (this.window instanceof Ci.nsIDOMWindow) {
            if (!this.consoleProgressListener) {
              this.consoleProgressListener =
                new ConsoleProgressListener(this.window, this);
            }
            this.consoleProgressListener.startMonitor(this.consoleProgressListener
                                                      .MONITOR_FILE_ACTIVITY);
            startedListeners.push(listener);
          }
          break;
        case "ReflowActivity":
          // Workers don't support this message type
          if (isWorker) {
            break;
          }
          if (!this.consoleReflowListener) {
            this.consoleReflowListener =
              new ConsoleReflowListener(this.window, this);
          }
          startedListeners.push(listener);
          break;
        case "ContentProcessMessages":
          // Workers don't support this message type
          if (isWorker) {
            break;
          }
          if (!this.contentProcessListener) {
            this.contentProcessListener = new ContentProcessListener(this);
          }
          startedListeners.push(listener);
          break;
        case "DocumentEvents":
          // Workers don't support this message type
          if (isWorker) {
            break;
          }
          if (!this.documentEventsListener) {
            this.documentEventsListener = new DocumentEventsListener(this);
          }
          startedListeners.push(listener);
          break;
      }
    }

    // Update the live list of running listeners
    startedListeners.forEach(this._listeners.add, this._listeners);

    return {
      startedListeners: startedListeners,
      nativeConsoleAPI: this.hasNativeConsoleAPI(this.window),
      traits: this.traits,
    };
  },

  /**
   * Handler for the "stopListeners" request.
   *
   * @param object request
   *        The JSON request object received from the Web Console client.
   * @return object
   *         The response packet to send to the client: holds the
   *         stoppedListeners array.
   */
  stopListeners: function(request) {
    const stoppedListeners = [];

    // If no specific listeners are requested to be detached, we stop all
    // listeners.
    const toDetach = request.listeners ||
      ["PageError", "ConsoleAPI", "NetworkActivity",
       "FileActivity", "ContentProcessMessages"];

    while (toDetach.length > 0) {
      const listener = toDetach.shift();
      switch (listener) {
        case "PageError":
          if (this.consoleServiceListener) {
            this.consoleServiceListener.destroy();
            this.consoleServiceListener = null;
          }
          stoppedListeners.push(listener);
          break;
        case "ConsoleAPI":
          if (this.consoleAPIListener) {
            this.consoleAPIListener.destroy();
            this.consoleAPIListener = null;
          }
          stoppedListeners.push(listener);
          break;
        case "NetworkActivity":
          if (this.netmonitors) {
            for (const { messageManager } of this.netmonitors) {
              messageManager.sendAsyncMessage("debug:destroy-network-monitor", {
                actorID: this.actorID
              });
            }
            this.netmonitors = null;
          }
          if (this.stackTraceCollector) {
            this.stackTraceCollector.destroy();
            this.stackTraceCollector = null;
          }
          stoppedListeners.push(listener);
          break;
        case "FileActivity":
          if (this.consoleProgressListener) {
            this.consoleProgressListener.stopMonitor(this.consoleProgressListener
                                                     .MONITOR_FILE_ACTIVITY);
            this.consoleProgressListener = null;
          }
          stoppedListeners.push(listener);
          break;
        case "ReflowActivity":
          if (this.consoleReflowListener) {
            this.consoleReflowListener.destroy();
            this.consoleReflowListener = null;
          }
          stoppedListeners.push(listener);
          break;
        case "ContentProcessMessages":
          if (this.contentProcessListener) {
            this.contentProcessListener.destroy();
            this.contentProcessListener = null;
          }
          stoppedListeners.push(listener);
          break;
        case "DocumentEvents":
          if (this.documentEventsListener) {
            this.documentEventsListener.destroy();
            this.documentEventsListener = null;
          }
          stoppedListeners.push(listener);
          break;
      }
    }

    // Update the live list of running listeners
    stoppedListeners.forEach(this._listeners.delete, this._listeners);

    return { stoppedListeners: stoppedListeners };
  },

  /**
   * Handler for the "getCachedMessages" request. This method sends the cached
   * error messages and the window.console API calls to the client.
   *
   * @param object request
   *        The JSON request object received from the Web Console client.
   * @return object
   *         The response packet to send to the client: it holds the cached
   *         messages array.
   */
  getCachedMessages: function(request) {
    const types = request.messageTypes;
    if (!types) {
      return {
        error: "missingParameter",
        message: "The messageTypes parameter is missing.",
      };
    }

    const messages = [];

    let replayingMessages = [];
    if (this.dbg.replaying) {
      replayingMessages = this.dbg.findAllConsoleMessages().filter(msg => {
        return !this.isDuplicateReplayingMessage(msg);
      });
    }

    while (types.length > 0) {
      const type = types.shift();
      switch (type) {
        case "ConsoleAPI": {
          replayingMessages.forEach((msg) => {
            if (msg.messageType == "ConsoleAPI") {
              const message = this.prepareConsoleMessageForRemote(msg);
              message._type = type;
              messages.push(message);
            }
          });

          if (!this.consoleAPIListener) {
            break;
          }

          // See `window` definition. It isn't always a DOM Window.
          const winStartTime = this.window && this.window.performance ?
            this.window.performance.timing.navigationStart : 0;

          const cache = this.consoleAPIListener
                      .getCachedMessages(!this.parentActor.isRootActor);
          cache.forEach((cachedMessage) => {
            // Filter out messages that came from a ServiceWorker but happened
            // before the page was requested.
            if (cachedMessage.innerID === "ServiceWorker" &&
                winStartTime > cachedMessage.timeStamp) {
              return;
            }

            const message = this.prepareConsoleMessageForRemote(cachedMessage);
            message._type = type;
            messages.push(message);
          });
          break;
        }
        case "PageError": {
          replayingMessages.forEach((msg) => {
            if (msg.messageType == "PageError") {
              const message = this.preparePageErrorForRemote(msg);
              message._type = type;
              messages.push(message);
            }
          });

          if (!this.consoleServiceListener) {
            break;
          }
          const cache = this.consoleServiceListener
                      .getCachedMessages(!this.parentActor.isRootActor);
          cache.forEach((cachedMessage) => {
            let message = null;
            if (cachedMessage instanceof Ci.nsIScriptError) {
              message = this.preparePageErrorForRemote(cachedMessage);
              message._type = type;
            } else {
              message = {
                _type: "LogMessage",
                message: this._createStringGrip(cachedMessage.message),
                timeStamp: cachedMessage.timeStamp,
              };
            }
            messages.push(message);
          });
          break;
        }
      }
    }

    return {
      from: this.actorID,
      messages: messages,
    };
  },

  /**
   * Handler for the "evaluateJSAsync" request. This method evaluates the given
   * JavaScript string and sends back a packet with a unique ID.
   * The result will be returned later as an unsolicited `evaluationResult`,
   * that can be associated back to this request via the `resultID` field.
   * Cannot be async, see Comment two on Bug #1452920
   *
   * @param object request
   *        The JSON request object received from the Web Console client.
   * @return object
   *         The response packet to send to with the unique id in the
   *         `resultID` field.
   */
  evaluateJSAsync: function(request) {
    // We want to be able to run console commands without waiting
    // for the first to return (see Bug 1088861).

    // First, send a response packet with the id only.
    const resultID = Date.now();
    this.conn.send({
      from: this.actorID,
      resultID: resultID
    });

    // Then, execute the script that may pause.
    const response = this.evaluateJS(request);
    response.resultID = resultID;

    this._waitForHelperResultAndSend(response).catch(e =>
      DevToolsUtils.reportException(
        "evaluateJSAsync",
        Error(`Encountered error while waiting for Helper Result: ${e}`)
      )
    );
  },

  /**
   * In order to have asynchronous commands such as screenshot, we have to be
   * able to handle promises in the helper result. This method handles waiting
   * for the promise, and then dispatching the result
   *
   *
   * @private
   * @param object response
   *         The response packet to send to with the unique id in the
   *         `resultID` field, and potentially a promise in the helperResult
   *         field.
   *
   * @return object
   *         The response packet to send to with the unique id in the
   *         `resultID` field, with a sanitized helperResult field.
   */
  _waitForHelperResultAndSend: async function(response) {
    // Wait for asynchronous command completion before sending back the response
    if (
      response.helperResult &&
      typeof response.helperResult.then == "function"
    ) {
      response.helperResult = await response.helperResult;
    }

    // Finally, send an unsolicited evaluationResult packet with
    // the normal return value
    this.conn.sendActorEvent(this.actorID, "evaluationResult", response);
  },

  /**
   * Handler for the "evaluateJS" request. This method evaluates the given
   * JavaScript string and sends back the result.
   *
   * @param object request
   *        The JSON request object received from the Web Console client.
   * @return object
   *         The evaluation response packet.
   */
  evaluateJS: function(request) {
    const input = request.text;
    const timestamp = Date.now();

    const evalOptions = {
      bindObjectActor: request.bindObjectActor,
      frameActor: request.frameActor,
      url: request.url,
      selectedNodeActor: request.selectedNodeActor,
      selectedObjectActor: request.selectedObjectActor,
    };

    const evalInfo = evalWithDebugger(input, evalOptions, this);
    const evalResult = evalInfo.result;
    const helperResult = evalInfo.helperResult;

    let result, errorDocURL, errorMessage, errorNotes = null, errorGrip = null,
      frame = null;
    if (evalResult) {
      if ("return" in evalResult) {
        result = evalResult.return;
      } else if ("yield" in evalResult) {
        result = evalResult.yield;
      } else if ("throw" in evalResult) {
        const error = evalResult.throw;

        errorGrip = this.createValueGrip(error);

        errorMessage = String(error);
        if (typeof error === "object" && error !== null) {
          try {
            errorMessage = DevToolsUtils.callPropertyOnObject(error, "toString");
          } catch (e) {
            // If the debuggee is not allowed to access the "toString" property
            // of the error object, calling this property from the debuggee's
            // compartment will fail. The debugger should show the error object
            // as it is seen by the debuggee, so this behavior is correct.
            //
            // Unfortunately, we have at least one test that assumes calling the
            // "toString" property of an error object will succeed if the
            // debugger is allowed to access it, regardless of whether the
            // debuggee is allowed to access it or not.
            //
            // To accomodate these tests, if calling the "toString" property
            // from the debuggee compartment fails, we rewrap the error object
            // in the debugger's compartment, and then call the "toString"
            // property from there.
            if (typeof error.unsafeDereference === "function") {
              errorMessage = error.unsafeDereference().toString();
            }
          }
        }

        // It is possible that we won't have permission to unwrap an
        // object and retrieve its errorMessageName.
        try {
          errorDocURL = ErrorDocs.GetURL(error);
        } catch (ex) {
          // ignored
        }

        try {
          const line = error.errorLineNumber;
          const column = error.errorColumnNumber;

          if (typeof line === "number" && typeof column === "number") {
            // Set frame only if we have line/column numbers.
            frame = {
              source: "debugger eval code",
              line,
              column
            };
          }
        } catch (ex) {
          // ignored
        }

        try {
          const notes = error.errorNotes;
          if (notes && notes.length) {
            errorNotes = [];
            for (const note of notes) {
              errorNotes.push({
                messageBody: this._createStringGrip(note.message),
                frame: {
                  source: note.fileName,
                  line: note.lineNumber,
                  column: note.columnNumber,
                }
              });
            }
          }
        } catch (ex) {
          // ignored
        }
      }
    }

    // If a value is encountered that the debugger server doesn't support yet,
    // the console should remain functional.
    let resultGrip;
    try {
      resultGrip = this.createValueGrip(result);
    } catch (e) {
      errorMessage = e;
    }

    this._lastConsoleInputEvaluation = result;

    return {
      from: this.actorID,
      input: input,
      result: resultGrip,
      timestamp: timestamp,
      exception: errorGrip,
      exceptionMessage: this._createStringGrip(errorMessage),
      exceptionDocURL: errorDocURL,
      frame,
      helperResult: helperResult,
      notes: errorNotes,
    };
  },

  /**
   * The Autocomplete request handler.
   *
   * @param object request
   *        The request message - what input to autocomplete.
   * @return object
   *         The response message - matched properties.
   */
  autocomplete: function(request) {
    const frameActorId = request.frameActor;
    let dbgObject = null;
    let environment = null;
    let hadDebuggee = false;
    let matches = [];
    let matchProp;
    const reqText = request.text.substr(0, request.cursor);

    if (isCommand(reqText)) {
      const commandsCache = this._getWebConsoleCommandsCache();
      matchProp = reqText;
      matches = validCommands
        .filter(c => `:${c}`.startsWith(reqText)
          && commandsCache.find(n => `:${n}`.startsWith(reqText))
        )
        .map(c => `:${c}`);
    } else {
      // This is the case of the paused debugger
      if (frameActorId) {
        const frameActor = this.conn.getActor(frameActorId);
        try {
          // Need to try/catch since accessing frame.environment
          // can throw "Debugger.Frame is not live"
          const frame = frameActor.frame;
          environment = frame.environment;
        } catch (e) {
          DevToolsUtils.reportException("autocomplete",
            Error("The frame actor was not found: " + frameActorId));
        }
      } else {
        // This is the general case (non-paused debugger)
        hadDebuggee = this.dbg.hasDebuggee(this.evalWindow);
        dbgObject = this.dbg.addDebuggee(this.evalWindow);
      }

      const result = JSPropertyProvider(dbgObject, environment, request.text,
                                      request.cursor, frameActorId) || {};

      if (!hadDebuggee && dbgObject) {
        this.dbg.removeDebuggee(this.evalWindow);
      }

      matches = result.matches || [];
      matchProp = result.matchProp;

      // We consider '$' as alphanumeric because it is used in the names of some
      // helper functions; we also consider whitespace as alphanum since it should not
      // be seen as break in the evaled string.
      const lastNonAlphaIsDot = /[.][a-zA-Z0-9$\s]*$/.test(reqText);
      if (!lastNonAlphaIsDot) {
        matches = matches.concat(this._getWebConsoleCommandsCache().filter(n =>
          // filter out `screenshot` command as it is inaccessible without
          // the `:` prefix
          n !== "screenshot" && n.startsWith(result.matchProp)
        ));
      }
    }

    // Make sure we return an array with unique items, since `matches` can hold twice
    // the same function name if it was defined in the content page and match an helper
    // function (e.g. $, keys, …).
    matches = [...new Set(matches)].sort();

    return {
      from: this.actorID,
      matches,
      matchProp,
    };
  },

  /**
   * The "clearMessagesCache" request handler.
   */
  clearMessagesCache: function() {
    // TODO: Bug 717611 - Web Console clear button does not clear cached errors
    const windowId = !this.parentActor.isRootActor ?
                   WebConsoleUtils.getInnerWindowId(this.window) : null;
    const ConsoleAPIStorage = Cc["@mozilla.org/consoleAPI-storage;1"]
                              .getService(Ci.nsIConsoleAPIStorage);
    ConsoleAPIStorage.clearEvents(windowId);

    CONSOLE_WORKER_IDS.forEach((id) => {
      ConsoleAPIStorage.clearEvents(id);
    });

    if (this.parentActor.isRootActor) {
      Services.console.reset();
    }
    return {};
  },

  /**
   * The "getPreferences" request handler.
   *
   * @param object request
   *        The request message - which preferences need to be retrieved.
   * @return object
   *         The response message - a { key: value } object map.
   */
  getPreferences: function(request) {
    const prefs = Object.create(null);
    for (const key of request.preferences) {
      prefs[key] = this._prefs[key];
    }
    return { preferences: prefs };
  },

  /**
   * The "setPreferences" request handler.
   *
   * @param object request
   *        The request message - which preferences need to be updated.
   */
  setPreferences: function(request) {
    for (const key in request.preferences) {
      this._prefs[key] = request.preferences[key];

      if (this.netmonitors) {
        if (key == "NetworkMonitor.saveRequestAndResponseBodies") {
          for (const { messageManager } of this.netmonitors) {
            messageManager.sendAsyncMessage("debug:netmonitor-preference", {
              saveRequestAndResponseBodies: this._prefs[key]
            });
          }
        } else if (key == "NetworkMonitor.throttleData") {
          for (const { messageManager } of this.netmonitors) {
            messageManager.sendAsyncMessage("debug:netmonitor-preference", {
              throttleData: this._prefs[key]
            });
          }
        }
      }
    }
    return { updated: Object.keys(request.preferences) };
  },

  // End of request handlers.

  /**
   * Create an object with the API we expose to the Web Console during
   * JavaScript evaluation.
   * This object inherits properties and methods from the Web Console actor.
   *
   * @private
   * @param object debuggerGlobal
   *        A Debugger.Object that wraps a content global. This is used for the
   *        Web Console Commands.
   * @return object
   *         The same object as |this|, but with an added |sandbox| property.
   *         The sandbox holds methods and properties that can be used as
   *         bindings during JS evaluation.
   */
  _getWebConsoleCommands: function(debuggerGlobal) {
    const helpers = {
      window: this.evalWindow,
      chromeWindow: this.chromeWindow.bind(this),
      makeDebuggeeValue: debuggerGlobal.makeDebuggeeValue.bind(debuggerGlobal),
      createValueGrip: this.createValueGrip.bind(this),
      sandbox: Object.create(null),
      helperResult: null,
      consoleActor: this,
    };
    addWebConsoleCommands(helpers);

    const evalWindow = this.evalWindow;
    function maybeExport(obj, name) {
      if (typeof obj[name] != "function") {
        return;
      }

      // By default, chrome-implemented functions that are exposed to content
      // refuse to accept arguments that are cross-origin for the caller. This
      // is generally the safe thing, but causes problems for certain console
      // helpers like cd(), where we users sometimes want to pass a cross-origin
      // window. To circumvent this restriction, we use exportFunction along
      // with a special option designed for this purpose. See bug 1051224.
      obj[name] =
        Cu.exportFunction(obj[name], evalWindow, { allowCrossOriginArguments: true });
    }
    for (const name in helpers.sandbox) {
      const desc = Object.getOwnPropertyDescriptor(helpers.sandbox, name);

      // Workers don't have access to Cu so won't be able to exportFunction.
      if (!isWorker) {
        maybeExport(desc, "get");
        maybeExport(desc, "set");
        maybeExport(desc, "value");
      }
      if (desc.value) {
        // Make sure the helpers can be used during eval.
        desc.value = debuggerGlobal.makeDebuggeeValue(desc.value);
      }
      Object.defineProperty(helpers.sandbox, name, desc);
    }
    return helpers;
  },

  _getWebConsoleCommandsCache: function() {
    if (!this._webConsoleCommandsCache) {
      const helpers = {
        sandbox: Object.create(null)
      };
      addWebConsoleCommands(helpers);
      this._webConsoleCommandsCache = Object.getOwnPropertyNames(helpers.sandbox);
    }
    return this._webConsoleCommandsCache;
  },

  // Event handlers for various listeners.

  /**
   * Handle console messages sent to us from a replaying process via the
   * debugger.
   */
  onReplayingMessage: function(msg) {
    if (this.isDuplicateReplayingMessage(msg)) {
      return;
    }

    if (msg.messageType == "ConsoleAPI") {
      this.onConsoleAPICall(msg);
    }

    if (msg.messageType == "PageError") {
      const packet = {
        from: this.actorID,
        type: "pageError",
        pageError: this.preparePageErrorForRemote(msg),
      };
      this.conn.send(packet);
    }
  },

  /**
   * Handler for messages received from the ConsoleServiceListener. This method
   * sends the nsIConsoleMessage to the remote Web Console client.
   *
   * @param nsIConsoleMessage message
   *        The message we need to send to the client.
   */
  onConsoleServiceMessage: function(message) {
    let packet;
    if (message instanceof Ci.nsIScriptError) {
      packet = {
        from: this.actorID,
        type: "pageError",
        pageError: this.preparePageErrorForRemote(message),
      };
    } else {
      packet = {
        from: this.actorID,
        type: "logMessage",
        message: this._createStringGrip(message.message),
        timeStamp: message.timeStamp,
      };
    }
    this.conn.send(packet);
  },

  /**
   * Prepare an nsIScriptError to be sent to the client.
   *
   * @param nsIScriptError pageError
   *        The page error we need to send to the client.
   * @return object
   *         The object you can send to the remote client.
   */
  preparePageErrorForRemote: function(pageError) {
    let stack = null;
    // Convert stack objects to the JSON attributes expected by client code
    // Bug 1348885: If the global from which this error came from has been
    // nuked, stack is going to be a dead wrapper.
    if (pageError.stack && !Cu.isDeadWrapper(pageError.stack)) {
      stack = [];
      let s = pageError.stack;
      while (s !== null) {
        stack.push({
          filename: s.source,
          lineNumber: s.line,
          columnNumber: s.column,
          functionName: s.functionDisplayName
        });
        s = s.parent;
      }
    }
    let lineText = pageError.sourceLine;
    if (lineText && lineText.length > DebuggerServer.LONG_STRING_INITIAL_LENGTH) {
      lineText = lineText.substr(0, DebuggerServer.LONG_STRING_INITIAL_LENGTH);
    }

    let notesArray = null;
    const notes = pageError.notes;
    if (notes && notes.length) {
      notesArray = [];
      for (let i = 0, len = notes.length; i < len; i++) {
        const note = notes.queryElementAt(i, Ci.nsIScriptErrorNote);
        notesArray.push({
          messageBody: this._createStringGrip(note.errorMessage),
          frame: {
            source: note.sourceName,
            line: note.lineNumber,
            column: note.columnNumber,
          }
        });
      }
    }

    return {
      errorMessage: this._createStringGrip(pageError.errorMessage),
      errorMessageName: pageError.errorMessageName,
      exceptionDocURL: ErrorDocs.GetURL(pageError),
      sourceName: pageError.sourceName,
      lineText: lineText,
      lineNumber: pageError.lineNumber,
      columnNumber: pageError.columnNumber,
      category: pageError.category,
      timeStamp: pageError.timeStamp,
      warning: !!(pageError.flags & pageError.warningFlag),
      error: !!(pageError.flags & pageError.errorFlag),
      exception: !!(pageError.flags & pageError.exceptionFlag),
      strict: !!(pageError.flags & pageError.strictFlag),
      info: !!(pageError.flags & pageError.infoFlag),
      private: pageError.isFromPrivateWindow,
      stacktrace: stack,
      notes: notesArray,
      executionPoint: pageError.executionPoint,
    };
  },

  /**
   * Handler for window.console API calls received from the ConsoleAPIListener.
   * This method sends the object to the remote Web Console client.
   *
   * @see ConsoleAPIListener
   * @param object message
   *        The console API call we need to send to the remote client.
   */
  onConsoleAPICall: function(message) {
    const packet = {
      from: this.actorID,
      type: "consoleAPICall",
      message: this.prepareConsoleMessageForRemote(message),
    };
    this.conn.send(packet);
  },

  /**
   * Get the NetworkEventActor for a given URL that may have been noticed by the network
   * listener.  Requests are added when they start, so the actor might not yet have all
   * data for the request until it has completed.
   *
   * @param string url
   *        The URL of the request to search for.
   */
  getRequestContentForURL(url) {
    if (!this.netmonitors) {
      return null;
    }
    return new Promise(resolve => {
      let messagesReceived = 0;
      const onMessage = ({ data }) => {
        // Resolve early if the console actor is destroyed
        if (!this.netmonitors) {
          resolve(null);
          return;
        }
        if (data.url != url) {
          return;
        }
        messagesReceived++;
        // Either use the first response with a content, or return a null content
        // if we received the responses from all the message managers.
        if (data.content || messagesReceived == this.netmonitors.length) {
          for (const { messageManager } of this.netmonitors) {
            messageManager.removeMessageListener("debug:request-content", onMessage);
          }
          resolve(data.content);
        }
      };
      for (const { messageManager } of this.netmonitors) {
        messageManager.addMessageListener("debug:request-content", onMessage);
        messageManager.sendAsyncMessage("debug:request-content", { url });
      }
    });
  },

  /**
   * Send a new HTTP request from the target's window.
   *
   * @param object message
   *        Object with 'request' - the HTTP request details.
   */
  async sendHTTPRequest({ request }) {
    const { url, method, headers, body } = request;

    // Set the loadingNode and loadGroup to the target document - otherwise the
    // request won't show up in the opened netmonitor.
    const doc = this.window.document;

    const channel = NetUtil.newChannel({
      uri: NetUtil.newURI(url),
      loadingNode: doc,
      securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_DATA_IS_NULL,
      contentPolicyType: Ci.nsIContentPolicy.TYPE_OTHER
    });

    channel.QueryInterface(Ci.nsIHttpChannel);

    channel.loadGroup = doc.documentLoadGroup;
    channel.loadFlags |= Ci.nsIRequest.LOAD_BYPASS_CACHE |
                         Ci.nsIRequest.INHIBIT_CACHING |
                         Ci.nsIRequest.LOAD_ANONYMOUS;

    channel.requestMethod = method;

    for (const {name, value} of headers) {
      channel.setRequestHeader(name, value, false);
    }

    if (body) {
      channel.QueryInterface(Ci.nsIUploadChannel2);
      const bodyStream = Cc["@mozilla.org/io/string-input-stream;1"]
        .createInstance(Ci.nsIStringInputStream);
      bodyStream.setData(body, body.length);
      channel.explicitSetUploadStream(bodyStream, null, -1, method, false);
    }

    NetUtil.asyncFetch(channel, () => {});

    if (!this.netmonitors) {
      return null;
    }
    const { channelId } = channel;
    // Only query the NetworkMonitorActor running in the parent process, where the
    // request will be done. There always is one listener running in the parent process,
    // see startListeners.
    const netmonitor = this.netmonitors.filter(({ parentProcess }) => parentProcess)[0];
    const { messageManager } = netmonitor;
    return new Promise(resolve => {
      const onMessage = ({ data }) => {
        if (data.channelId == channelId) {
          messageManager.removeMessageListener("debug:get-network-event-actor",
            onMessage);
          resolve({
            eventActor: data.actor
          });
        }
      };
      messageManager.addMessageListener("debug:get-network-event-actor", onMessage);
      messageManager.sendAsyncMessage("debug:get-network-event-actor", { channelId });
    });
  },

  /**
   * Handler for file activity. This method sends the file request information
   * to the remote Web Console client.
   *
   * @see ConsoleProgressListener
   * @param string fileURI
   *        The requested file URI.
   */
  onFileActivity: function(fileURI) {
    const packet = {
      from: this.actorID,
      type: "fileActivity",
      uri: fileURI,
    };
    this.conn.send(packet);
  },

  /**
   * Handler for reflow activity. This method forwards reflow events to the
   * remote Web Console client.
   *
   * @see ConsoleReflowListener
   * @param Object reflowInfo
   */
  onReflowActivity: function(reflowInfo) {
    const packet = {
      from: this.actorID,
      type: "reflowActivity",
      interruptible: reflowInfo.interruptible,
      start: reflowInfo.start,
      end: reflowInfo.end,
      sourceURL: reflowInfo.sourceURL,
      sourceLine: reflowInfo.sourceLine,
      functionName: reflowInfo.functionName
    };

    this.conn.send(packet);
  },

  // End of event handlers for various listeners.

  /**
   * Prepare a message from the console API to be sent to the remote Web Console
   * instance.
   *
   * @param object message
   *        The original message received from console-api-log-event.
   * @param boolean aUseObjectGlobal
   *        If |true| the object global is determined and added as a debuggee,
   *        otherwise |this.window| is used when makeDebuggeeValue() is invoked.
   * @return object
   *         The object that can be sent to the remote client.
   */
  prepareConsoleMessageForRemote: function(message, useObjectGlobal = true) {
    const result = WebConsoleUtils.cloneObject(message);

    result.workerType = WebConsoleUtils.getWorkerType(result) || "none";

    delete result.wrappedJSObject;
    delete result.ID;
    delete result.innerID;
    delete result.consoleID;

    result.arguments = Array.map(message.arguments || [], (obj) => {
      const dbgObj = this.makeDebuggeeValue(obj, useObjectGlobal);
      return this.createValueGrip(dbgObj);
    });

    result.styles = Array.map(message.styles || [], (string) => {
      return this.createValueGrip(string);
    });

    result.category = message.category || "webdev";

    return result;
  },

  /**
   * Find the XUL window that owns the content window.
   *
   * @return Window
   *         The XUL window that owns the content window.
   */
  chromeWindow: function() {
    let window = null;
    try {
      window = this.window.docShell.chromeEventHandler.ownerGlobal;
    } catch (ex) {
      // The above can fail because chromeEventHandler is not available for all
      // kinds of |this.window|.
    }

    return window;
  },

  /**
   * Notification observer for the "last-pb-context-exited" topic.
   *
   * @private
   * @param object subject
   *        Notification subject - in this case it is the inner window ID that
   *        was destroyed.
   * @param string topic
   *        Notification topic.
   */
  _onObserverNotification: function(subject, topic) {
    switch (topic) {
      case "last-pb-context-exited":
        this.conn.send({
          from: this.actorID,
          type: "lastPrivateContextExited",
        });
        break;
    }
  },

  /**
   * The "will-navigate" progress listener. This is used to clear the current
   * eval scope.
   */
  _onWillNavigate: function({ window, isTopLevel }) {
    if (isTopLevel) {
      this._evalWindow = null;
      EventEmitter.off(this.parentActor, "will-navigate", this._onWillNavigate);
      this._progressListenerActive = false;
    }
  },

  /**
   * This listener is called when we switch to another frame,
   * mostly to unregister previous listeners and start listening on the new document.
   */
  _onChangedToplevelDocument: function() {
    // Convert the Set to an Array
    const listeners = [...this._listeners];

    // Unregister existing listener on the previous document
    // (pass a copy of the array as it will shift from it)
    this.stopListeners({listeners: listeners.slice()});

    // This method is called after this.window is changed,
    // so we register new listener on this new window
    this.startListeners({listeners: listeners});

    // Also reset the cached top level chrome window being targeted
    this._lastChromeWindow = null;
  },
};

WebConsoleActor.prototype.requestTypes =
{
  startListeners: WebConsoleActor.prototype.startListeners,
  stopListeners: WebConsoleActor.prototype.stopListeners,
  getCachedMessages: WebConsoleActor.prototype.getCachedMessages,
  evaluateJS: WebConsoleActor.prototype.evaluateJS,
  evaluateJSAsync: WebConsoleActor.prototype.evaluateJSAsync,
  autocomplete: WebConsoleActor.prototype.autocomplete,
  clearMessagesCache: WebConsoleActor.prototype.clearMessagesCache,
  getPreferences: WebConsoleActor.prototype.getPreferences,
  setPreferences: WebConsoleActor.prototype.setPreferences,
  sendHTTPRequest: WebConsoleActor.prototype.sendHTTPRequest
};

exports.WebConsoleActor = WebConsoleActor;
