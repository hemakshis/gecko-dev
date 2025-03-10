/* -*- js-indent-level: 2; indent-tabs-mode: nil -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

ChromeUtils.import("resource://gre/modules/Log.jsm");
ChromeUtils.import("resource://gre/modules/Services.jsm", this);
ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm", this);
ChromeUtils.import("resource://gre/modules/DeferredTask.jsm", this);
ChromeUtils.import("resource://gre/modules/Timer.jsm");
ChromeUtils.import("resource://gre/modules/TelemetryUtils.jsm", this);
ChromeUtils.import("resource://gre/modules/AppConstants.jsm");

XPCOMUtils.defineLazyModuleGetters(this, {
  AddonManagerPrivate: "resource://gre/modules/AddonManager.jsm",
  TelemetryController: "resource://gre/modules/TelemetryController.jsm",
  TelemetryStorage: "resource://gre/modules/TelemetryStorage.jsm",
  UITelemetry: "resource://gre/modules/UITelemetry.jsm",
  GCTelemetry: "resource://gre/modules/GCTelemetry.jsm",
  TelemetryEnvironment: "resource://gre/modules/TelemetryEnvironment.jsm",
  TelemetryReportingPolicy: "resource://gre/modules/TelemetryReportingPolicy.jsm",
});

const Utils = TelemetryUtils;

const myScope = this;

// When modifying the payload in incompatible ways, please bump this version number
const PAYLOAD_VERSION = 4;
const PING_TYPE_MAIN = "main";
const PING_TYPE_SAVED_SESSION = "saved-session";

const REASON_ABORTED_SESSION = "aborted-session";
const REASON_DAILY = "daily";
const REASON_SAVED_SESSION = "saved-session";
const REASON_GATHER_PAYLOAD = "gather-payload";
const REASON_GATHER_SUBSESSION_PAYLOAD = "gather-subsession-payload";
const REASON_TEST_PING = "test-ping";
const REASON_ENVIRONMENT_CHANGE = "environment-change";
const REASON_SHUTDOWN = "shutdown";

const ENVIRONMENT_CHANGE_LISTENER = "TelemetrySession::onEnvironmentChange";

const MIN_SUBSESSION_LENGTH_MS = Services.prefs.getIntPref("toolkit.telemetry.minSubsessionLength", 5 * 60) * 1000;

const LOGGER_NAME = "Toolkit.Telemetry";
const LOGGER_PREFIX = "TelemetrySession" + (Utils.isContentProcess ? "#content::" : "::");

const MESSAGE_TELEMETRY_USS = "Telemetry:USS";
const MESSAGE_TELEMETRY_GET_CHILD_USS = "Telemetry:GetChildUSS";

// Whether the FHR/Telemetry unification features are enabled.
// Changing this pref requires a restart.
const IS_UNIFIED_TELEMETRY = Services.prefs.getBoolPref(TelemetryUtils.Preferences.Unified, false);

// Do not gather data more than once a minute (ms)
const TELEMETRY_INTERVAL = 60 * 1000;
// Delay before intializing telemetry (ms)
const TELEMETRY_DELAY = Services.prefs.getIntPref("toolkit.telemetry.initDelay", 60) * 1000;
// Delay before initializing telemetry if we're testing (ms)
const TELEMETRY_TEST_DELAY = 1;
// Execute a scheduler tick every 5 minutes.
const SCHEDULER_TICK_INTERVAL_MS = Services.prefs.getIntPref("toolkit.telemetry.scheduler.tickInterval", 5 * 60) * 1000;
// When user is idle, execute a scheduler tick every 60 minutes.
const SCHEDULER_TICK_IDLE_INTERVAL_MS = Services.prefs.getIntPref("toolkit.telemetry.scheduler.idleTickInterval", 60 * 60) * 1000;

// The tolerance we have when checking if it's midnight (15 minutes).
const SCHEDULER_MIDNIGHT_TOLERANCE_MS = 15 * 60 * 1000;

// The maximum time (ms) until the tick should moved from the idle
// queue to the regular queue if it hasn't been executed yet.
const SCHEDULER_TICK_MAX_IDLE_DELAY_MS = 60 * 1000;

// Seconds of idle time before pinging.
// On idle-daily a gather-telemetry notification is fired, during it probes can
// start asynchronous tasks to gather data.
const IDLE_TIMEOUT_SECONDS = Services.prefs.getIntPref("toolkit.telemetry.idleTimeout", 5 * 60);

// The frequency at which we persist session data to the disk to prevent data loss
// in case of aborted sessions (currently 5 minutes).
const ABORTED_SESSION_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

const TOPIC_CYCLE_COLLECTOR_BEGIN = "cycle-collector-begin";

// How long to wait in millis for all the child memory reports to come in
const TOTAL_MEMORY_COLLECTOR_TIMEOUT = 200;

var gLastMemoryPoll = null;

var gWasDebuggerAttached = false;

XPCOMUtils.defineLazyServiceGetters(this, {
  Telemetry: ["@mozilla.org/base/telemetry;1", "nsITelemetry"],
  idleService: ["@mozilla.org/widget/idleservice;1", "nsIIdleService"],
});

function generateUUID() {
  let str = Cc["@mozilla.org/uuid-generator;1"].getService(Ci.nsIUUIDGenerator).generateUUID().toString();
  // strip {}
  return str.substring(1, str.length - 1);
}

function getMsSinceProcessStart() {
  try {
    return Telemetry.msSinceProcessStart();
  } catch (ex) {
    // If this fails return a special value.
    return -1;
  }
}

/**
 * This is a policy object used to override behavior for testing.
 */
var Policy = {
  now: () => new Date(),
  monotonicNow: getMsSinceProcessStart,
  generateSessionUUID: () => generateUUID(),
  generateSubsessionUUID: () => generateUUID(),
  setSchedulerTickTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearSchedulerTickTimeout: id => clearTimeout(id),
};

/**
 * Get the ping type based on the payload.
 * @param {Object} aPayload The ping payload.
 * @return {String} A string representing the ping type.
 */
function getPingType(aPayload) {
  // To remain consistent with server-side ping handling, set "saved-session" as the ping
  // type for "saved-session" payload reasons.
  if (aPayload.info.reason == REASON_SAVED_SESSION) {
    return PING_TYPE_SAVED_SESSION;
  }

  return PING_TYPE_MAIN;
}

/**
 * Annotate the current session ID with the crash reporter to map potential
 * crash pings with the related main ping.
 */
function annotateCrashReport(sessionId) {
  try {
    const cr = Cc["@mozilla.org/toolkit/crash-reporter;1"];
    if (cr) {
      cr.getService(Ci.nsICrashReporter).setTelemetrySessionId(sessionId);
    }
  } catch (e) {
    // Ignore errors when crash reporting is disabled
  }
}

/**
 * Read current process I/O counters.
 */
var processInfo = {
  _initialized: false,
  _IO_COUNTERS: null,
  _kernel32: null,
  _GetProcessIoCounters: null,
  _GetCurrentProcess: null,
  getCounters() {
    let isWindows = ("@mozilla.org/windows-registry-key;1" in Cc);
    if (isWindows)
      return this.getCounters_Windows();
    return null;
  },
  getCounters_Windows() {
    if (!this._initialized) {
      ChromeUtils.import("resource://gre/modules/ctypes.jsm");
      this._IO_COUNTERS = new ctypes.StructType("IO_COUNTERS", [
        {"readOps": ctypes.unsigned_long_long},
        {"writeOps": ctypes.unsigned_long_long},
        {"otherOps": ctypes.unsigned_long_long},
        {"readBytes": ctypes.unsigned_long_long},
        {"writeBytes": ctypes.unsigned_long_long},
        {"otherBytes": ctypes.unsigned_long_long} ]);
      try {
        this._kernel32 = ctypes.open("Kernel32.dll");
        this._GetProcessIoCounters = this._kernel32.declare("GetProcessIoCounters",
          ctypes.winapi_abi,
          ctypes.bool, // return
          ctypes.voidptr_t, // hProcess
          this._IO_COUNTERS.ptr); // lpIoCounters
        this._GetCurrentProcess = this._kernel32.declare("GetCurrentProcess",
          ctypes.winapi_abi,
          ctypes.voidptr_t); // return
        this._initialized = true;
      } catch (err) {
        return null;
      }
    }
    let io = new this._IO_COUNTERS();
    if (!this._GetProcessIoCounters(this._GetCurrentProcess(), io.address()))
      return null;
    return [parseInt(io.readBytes), parseInt(io.writeBytes)];
  }
};

/**
 * TelemetryScheduler contains a single timer driving all regularly-scheduled
 * Telemetry related jobs. Having a single place with this logic simplifies
 * reasoning about scheduling actions in a single place, making it easier to
 * coordinate jobs and coalesce them.
 */
var TelemetryScheduler = {
  _lastDailyPingTime: 0,
  _lastSessionCheckpointTime: 0,

  // For sanity checking.
  _lastAdhocPingTime: 0,
  _lastTickTime: 0,

  _log: null,

  // The timer which drives the scheduler.
  _schedulerTimer: null,
  // The interval used by the scheduler timer.
  _schedulerInterval: 0,
  _shuttingDown: true,
  _isUserIdle: false,

  /**
   * Initialises the scheduler and schedules the first daily/aborted session pings.
   */
  init() {
    this._log = Log.repository.getLoggerWithMessagePrefix(LOGGER_NAME, "TelemetryScheduler::");
    this._log.trace("init");
    this._shuttingDown = false;
    this._isUserIdle = false;

    // Initialize the last daily ping and aborted session last due times to the current time.
    // Otherwise, we might end up sending daily pings even if the subsession is not long enough.
    let now = Policy.now();
    this._lastDailyPingTime = now.getTime();
    this._lastSessionCheckpointTime = now.getTime();
    this._rescheduleTimeout();

    idleService.addIdleObserver(this, IDLE_TIMEOUT_SECONDS);
    Services.obs.addObserver(this, "wake_notification");
  },

  /**
   * Stops the scheduler.
   */
  shutdown() {
    if (this._shuttingDown) {
      if (this._log) {
        this._log.error("shutdown - Already shut down");
      } else {
        Cu.reportError("TelemetryScheduler.shutdown - Already shut down");
      }
      return;
    }

    this._log.trace("shutdown");
    if (this._schedulerTimer) {
      Policy.clearSchedulerTickTimeout(this._schedulerTimer);
      this._schedulerTimer = null;
    }

    idleService.removeIdleObserver(this, IDLE_TIMEOUT_SECONDS);
    Services.obs.removeObserver(this, "wake_notification");

    this._shuttingDown = true;
  },

  _clearTimeout() {
    if (this._schedulerTimer) {
      Policy.clearSchedulerTickTimeout(this._schedulerTimer);
    }
  },

  /**
   * Reschedules the tick timer.
   */
  _rescheduleTimeout() {
    this._log.trace("_rescheduleTimeout - isUserIdle: " + this._isUserIdle);
    if (this._shuttingDown) {
      this._log.warn("_rescheduleTimeout - already shutdown");
      return;
    }

    this._clearTimeout();

    const now = Policy.now();
    let timeout = SCHEDULER_TICK_INTERVAL_MS;

    // When the user is idle we want to fire the timer less often.
    if (this._isUserIdle) {
      timeout = SCHEDULER_TICK_IDLE_INTERVAL_MS;
      // We need to make sure though that we don't miss sending pings around
      // midnight when we use the longer idle intervals.
      const nextMidnight = Utils.getNextMidnight(now);
      timeout = Math.min(timeout, nextMidnight.getTime() - now.getTime());
    }

    this._log.trace("_rescheduleTimeout - scheduling next tick for " + new Date(now.getTime() + timeout));
    this._schedulerTimer =
      Policy.setSchedulerTickTimeout(() => this._onSchedulerTick(), timeout);
  },

  _sentDailyPingToday(nowDate) {
    // This is today's date and also the previous midnight (0:00).
    const todayDate = Utils.truncateToDays(nowDate);
    // We consider a ping sent for today if it occured after or at 00:00 today.
    return (this._lastDailyPingTime >= todayDate.getTime());
  },

  /**
   * Checks if we can send a daily ping or not.
   * @param {Object} nowDate A date object.
   * @return {Boolean} True if we can send the daily ping, false otherwise.
   */
  _isDailyPingDue(nowDate) {
    // The daily ping is not due if we already sent one today.
    if (this._sentDailyPingToday(nowDate)) {
      this._log.trace("_isDailyPingDue - already sent one today");
      return false;
    }

    // Avoid overly short sessions.
    const timeSinceLastDaily = nowDate.getTime() - this._lastDailyPingTime;
    if (timeSinceLastDaily < MIN_SUBSESSION_LENGTH_MS) {
      this._log.trace("_isDailyPingDue - delaying daily to keep minimum session length");
      return false;
    }

    this._log.trace("_isDailyPingDue - is due");
    return true;
  },

  /**
   * An helper function to save an aborted-session ping.
   * @param {Number} now The current time, in milliseconds.
   * @param {Object} [competingPayload=null] If we are coalescing the daily and the
   *                 aborted-session pings, this is the payload for the former. Note
   *                 that the reason field of this payload will be changed.
   * @return {Promise} A promise resolved when the ping is saved.
   */
  _saveAbortedPing(now, competingPayload = null) {
    this._lastSessionCheckpointTime = now;
    return Impl._saveAbortedSessionPing(competingPayload)
                .catch(e => this._log.error("_saveAbortedPing - Failed", e));
  },

  /**
   * The notifications handler.
   */
  observe(aSubject, aTopic, aData) {
    this._log.trace("observe - aTopic: " + aTopic);
    switch (aTopic) {
      case "idle":
        // If the user is idle, increase the tick interval.
        this._isUserIdle = true;
        return this._onSchedulerTick();
      case "active":
        // User is back to work, restore the original tick interval.
        this._isUserIdle = false;
        return this._onSchedulerTick(true);
      case "wake_notification":
        // The machine woke up from sleep, trigger a tick to avoid sessions
        // spanning more than a day.
        // This is needed because sleep time does not count towards timeouts
        // on Mac & Linux - see bug 1262386, bug 1204823 et al.
        return this._onSchedulerTick(true);
    }
    return undefined;
  },

  /**
   * Creates an object with a method `dispatch` that will call `dispatchFn` unless
   * the method `cancel` is called beforehand.
   *
   * This is used to wrap main thread idle dispatch since it does not provide a
   * cancel mechanism.
   */
  _makeIdleDispatch(dispatchFn) {
    this._log.trace("_makeIdleDispatch");
    let fn = dispatchFn;
    let l = (msg) => this._log.trace(msg); // need to bind `this`
    return {
      cancel() {
        fn = undefined;
      },
      dispatch(resolve, reject) {
        l("_makeIdleDispatch.dispatch - !!fn: " + !!fn);
        if (!fn) {
          return Promise.resolve().then(resolve, reject);
        }
        return fn(resolve, reject);
      },
    };
  },

  /**
   * Performs a scheduler tick. This function manages Telemetry recurring operations.
   * @param {Boolean} [dispatchOnIdle=false] If true, the tick is dispatched in the
   *                  next idle cycle of the main thread.
   * @return {Promise} A promise, only used when testing, resolved when the scheduled
   *                   operation completes.
   */
  _onSchedulerTick(dispatchOnIdle = false) {
    this._log.trace("_onSchedulerTick - dispatchOnIdle: " + dispatchOnIdle);
    // This call might not be triggered from a timeout. In that case we don't want to
    // leave any previously scheduled timeouts pending.
    this._clearTimeout();

    if (this._idleDispatch) {
      this._idleDispatch.cancel();
    }

    if (this._shuttingDown) {
      this._log.warn("_onSchedulerTick - already shutdown.");
      return Promise.reject(new Error("Already shutdown."));
    }

    let promise = Promise.resolve();
    try {
      if (dispatchOnIdle) {
        this._idleDispatch = this._makeIdleDispatch((resolve, reject) => {
          this._log.trace("_onSchedulerTick - ildeDispatchToMainThread dispatch");
          return this._schedulerTickLogic().then(resolve, reject);
        });
        promise = new Promise((resolve, reject) =>
          Services.tm.idleDispatchToMainThread(() => {
            return this._idleDispatch
              ? this._idleDispatch.dispatch(resolve, reject)
              : Promise.resolve().then(resolve, reject);
            },
            SCHEDULER_TICK_MAX_IDLE_DELAY_MS));
      } else {
        promise = this._schedulerTickLogic();
      }
    } catch (e) {
      Telemetry.getHistogramById("TELEMETRY_SCHEDULER_TICK_EXCEPTION").add(1);
      this._log.error("_onSchedulerTick - There was an exception", e);
    } finally {
      this._rescheduleTimeout();
    }

    // This promise is returned to make testing easier.
    return promise;
  },

  /**
   * Implements the scheduler logic.
   * @return {Promise} Resolved when the scheduled task completes. Only used in tests.
   */
  _schedulerTickLogic() {
    this._log.trace("_schedulerTickLogic");

    let nowDate = Policy.now();
    let now = nowDate.getTime();

    if ((now - this._lastTickTime) > (1.1 * SCHEDULER_TICK_INTERVAL_MS) &&
        (this._lastTickTime != 0)) {
      Telemetry.getHistogramById("TELEMETRY_SCHEDULER_WAKEUP").add(1);
      this._log.trace("_schedulerTickLogic - First scheduler tick after sleep.");
    }
    this._lastTickTime = now;

    // Check if the daily ping is due.
    const shouldSendDaily = this._isDailyPingDue(nowDate);

    if (shouldSendDaily) {
      this._log.trace("_schedulerTickLogic - Daily ping due.");
      this._lastDailyPingTime = now;
      return Impl._sendDailyPing();
    }

    // Check if the aborted-session ping is due. If a daily ping was saved above, it was
    // already duplicated as an aborted-session ping.
    const isAbortedPingDue =
      (now - this._lastSessionCheckpointTime) >= ABORTED_SESSION_UPDATE_INTERVAL_MS;
    if (isAbortedPingDue) {
      this._log.trace("_schedulerTickLogic - Aborted session ping due.");
      return this._saveAbortedPing(now);
    }

    // No ping is due.
    this._log.trace("_schedulerTickLogic - No ping due.");
    return Promise.resolve();
  },

  /**
   * Update the scheduled pings if some other ping was sent.
   * @param {String} reason The reason of the ping that was sent.
   * @param {Object} [competingPayload=null] The payload of the ping that was sent. The
   *                 reason of this payload will be changed.
   */
  reschedulePings(reason, competingPayload = null) {
    if (this._shuttingDown) {
      this._log.error("reschedulePings - already shutdown");
      return;
    }

    this._log.trace("reschedulePings - reason: " + reason);
    let now = Policy.now();
    this._lastAdhocPingTime = now.getTime();
    if (reason == REASON_ENVIRONMENT_CHANGE) {
      // We just generated an environment-changed ping, save it as an aborted session and
      // update the schedules.
      this._saveAbortedPing(now.getTime(), competingPayload);
      // If we're close to midnight, skip today's daily ping and reschedule it for tomorrow.
      let nearestMidnight = Utils.getNearestMidnight(now, SCHEDULER_MIDNIGHT_TOLERANCE_MS);
      if (nearestMidnight) {
        this._lastDailyPingTime = now.getTime();
      }
    }

    this._rescheduleTimeout();
  },
};

var EXPORTED_SYMBOLS = ["TelemetrySession"];

var TelemetrySession = Object.freeze({
  /**
   * Send a ping to a test server. Used only for testing.
   */
  testPing() {
    return Impl.testPing();
  },
  /**
   * Returns the current telemetry payload.
   * @param reason Optional, the reason to trigger the payload.
   * @param clearSubsession Optional, whether to clear subsession specific data.
   * @returns Object
   */
  getPayload(reason, clearSubsession = false) {
    return Impl.getPayload(reason, clearSubsession);
  },
  /**
   * Save the session state to a pending file.
   * Used only for testing purposes.
   */
  testSavePendingPing() {
    return Impl.testSavePendingPing();
  },
  /**
   * Collect and store information about startup.
   */
  gatherStartup() {
    return Impl.gatherStartup();
  },
  /**
   * Inform the ping which AddOns are installed.
   *
   * @param aAddOns - The AddOns.
   */
  setAddOns(aAddOns) {
    return Impl.setAddOns(aAddOns);
  },
  /**
   * Descriptive metadata
   *
   * @param  reason
   *         The reason for the telemetry ping, this will be included in the
   *         returned metadata,
   * @return The metadata as a JS object
   */
  getMetadata(reason) {
    return Impl.getMetadata(reason);
  },

  /**
   * Reset the subsession and profile subsession counter.
   * This should only be called when the profile should be considered completely new,
   * e.g. after opting out of sending Telemetry
   */
  resetSubsessionCounter() {
    Impl._subsessionCounter = 0;
    Impl._profileSubsessionCounter = 0;
  },

  /**
   * Used only for testing purposes.
   */
  testReset() {
    Impl._newProfilePingSent = false;
    Impl._sessionId = null;
    Impl._subsessionId = null;
    Impl._previousSessionId = null;
    Impl._previousSubsessionId = null;
    Impl._subsessionCounter = 0;
    Impl._profileSubsessionCounter = 0;
    Impl._subsessionStartActiveTicks = 0;
    Impl._sessionActiveTicks = 0;
    Impl._isUserActive = true;
    Impl._subsessionStartTimeMonotonic = 0;
    Impl._lastEnvironmentChangeDate = Policy.monotonicNow();
    this.testUninstall();
  },
  /**
   * Triggers shutdown of the module.
   */
  shutdown() {
    return Impl.shutdownChromeProcess();
  },
  /**
   * Sets up components used in the content process.
   */
  setupContent(testing = false) {
    return Impl.setupContentProcess(testing);
  },
  /**
   * Used only for testing purposes.
   */
  testUninstall() {
    try {
      Impl.uninstall();
    } catch (ex) {
      // Ignore errors
    }
  },
  /**
   * Lightweight init function, called as soon as Firefox starts.
   */
  earlyInit(aTesting = false) {
    return Impl.earlyInit(aTesting);
  },
  /**
   * Does the "heavy" Telemetry initialization later on, so we
   * don't impact startup performance.
   * @return {Promise} Resolved when the initialization completes.
   */
  delayedInit() {
    return Impl.delayedInit();
  },
  /**
   * Send a notification.
   */
  observe(aSubject, aTopic, aData) {
    return Impl.observe(aSubject, aTopic, aData);
  },
  /**
   * Marks the "new-profile" ping as sent in the telemetry state file.
   * @return {Promise} A promise resolved when the new telemetry state is saved to disk.
   */
  markNewProfilePingSent() {
    return Impl.markNewProfilePingSent();
  },
  /**
   * Returns if the "new-profile" ping has ever been sent for this profile.
   * Please note that the returned value is trustworthy only after the delayed setup.
   *
   * @return {Boolean} True if the new profile ping was sent on this profile,
   *         false otherwise.
   */
  get newProfilePingSent() {
    return Impl._newProfilePingSent;
  },
});

var Impl = {
  _initialized: false,
  _logger: null,
  _prevValues: {},
  _slowSQLStartup: {},
  // The activity state for the user. If false, don't count the next
  // active tick. Otherwise, increment the active ticks as usual.
  _isUserActive: true,
  _startupIO: {},
  // The previous build ID, if this is the first run with a new build.
  // Null if this is the first run, or the previous build ID is unknown.
  _previousBuildId: null,
  // Unique id that identifies this session so the server can cope with duplicate
  // submissions, orphaning and other oddities. The id is shared across subsessions.
  _sessionId: null,
  // Random subsession id.
  _subsessionId: null,
  // Session id of the previous session, null on first run.
  _previousSessionId: null,
  // Subsession id of the previous subsession (even if it was in a different session),
  // null on first run.
  _previousSubsessionId: null,
  // The running no. of subsessions since the start of the browser session
  _subsessionCounter: 0,
  // The running no. of all subsessions for the whole profile life time
  _profileSubsessionCounter: 0,
  // Date of the last session split
  _subsessionStartDate: null,
  // Start time of the current subsession using a monotonic clock for the subsession
  // length measurements.
  _subsessionStartTimeMonotonic: 0,
  // The active ticks counted when the subsession starts
  _subsessionStartActiveTicks: 0,
  // Active ticks in the whole session.
  _sessionActiveTicks: 0,
  // A task performing delayed initialization of the chrome process
  _delayedInitTask: null,
  // Need a timeout in case children are tardy in giving back their memory reports.
  _totalMemoryTimeout: undefined,
  _testing: false,
  // An accumulator of total memory across all processes. Only valid once the final child reports.
  _totalMemory: null,
  // A Set of outstanding USS report ids
  _childrenToHearFrom: null,
  // monotonically-increasing id for USS reports
  _nextTotalMemoryId: 1,
  _USSFromChildProcesses: null,
  _lastEnvironmentChangeDate: 0,
  // We save whether the "new-profile" ping was sent yet, to
  // survive profile refresh and migrations.
  _newProfilePingSent: false,
  // Keep track of the active observers
  _observedTopics: new Set(),

  addObserver(aTopic) {
    Services.obs.addObserver(this, aTopic);
    this._observedTopics.add(aTopic);
  },

  removeObserver(aTopic) {
    Services.obs.removeObserver(this, aTopic);
    this._observedTopics.delete(aTopic);
  },

  get _log() {
    if (!this._logger) {
      this._logger = Log.repository.getLoggerWithMessagePrefix(LOGGER_NAME, LOGGER_PREFIX);
    }
    return this._logger;
  },

  /**
   * Gets a series of simple measurements (counters). At the moment, this
   * only returns startup data from nsIAppStartup.getStartupInfo().
   * @param {Boolean} isSubsession True if this is a subsession, false otherwise.
   * @param {Boolean} clearSubsession True if a new subsession is being started, false otherwise.
   *
   * @return simple measurements as a dictionary.
   */
  getSimpleMeasurements: function getSimpleMeasurements(forSavedSession, isSubsession, clearSubsession) {
    let si = Services.startup.getStartupInfo();

    // Measurements common to chrome and content processes.
    let elapsedTime = Date.now() - si.process;
    var ret = {
      totalTime: Math.round(elapsedTime / 1000), // totalTime, in seconds
      uptime: Math.round(elapsedTime / 60000) // uptime in minutes
    };

    // Look for app-specific timestamps
    var appTimestamps = {};
    try {
      let o = {};
      ChromeUtils.import("resource://gre/modules/TelemetryTimestamps.jsm", o);
      appTimestamps = o.TelemetryTimestamps.get();
    } catch (ex) {}

    // Only submit this if the extended set is enabled.
    if (!Utils.isContentProcess && Telemetry.canRecordExtended) {
      try {
        ret.addonManager = AddonManagerPrivate.getSimpleMeasures();
      } catch (ex) {}
    }

    if (si.process) {
      for (let field of Object.keys(si)) {
        if (field == "process")
          continue;
        ret[field] = si[field] - si.process;
      }

      for (let p in appTimestamps) {
        if (!(p in ret) && appTimestamps[p])
          ret[p] = appTimestamps[p] - si.process;
      }
    }

    ret.startupInterrupted = Number(Services.startup.interrupted);

    let maximalNumberOfConcurrentThreads = Telemetry.maximalNumberOfConcurrentThreads;
    if (maximalNumberOfConcurrentThreads) {
      ret.maximalNumberOfConcurrentThreads = maximalNumberOfConcurrentThreads;
    }

    if (Utils.isContentProcess) {
      return ret;
    }

    // Measurements specific to chrome process

    // Update debuggerAttached flag
    let debugService = Cc["@mozilla.org/xpcom/debug;1"].getService(Ci.nsIDebug2);
    let isDebuggerAttached = debugService.isDebuggerAttached;
    gWasDebuggerAttached = gWasDebuggerAttached || isDebuggerAttached;
    ret.debuggerAttached = Number(gWasDebuggerAttached);

    let shutdownDuration = Telemetry.lastShutdownDuration;
    if (shutdownDuration)
      ret.shutdownDuration = shutdownDuration;

    let failedProfileLockCount = Telemetry.failedProfileLockCount;
    if (failedProfileLockCount)
      ret.failedProfileLockCount = failedProfileLockCount;

    for (let ioCounter in this._startupIO)
      ret[ioCounter] = this._startupIO[ioCounter];

    let activeTicks = this._sessionActiveTicks;
    if (isSubsession) {
      activeTicks = this._sessionActiveTicks - this._subsessionStartActiveTicks;
    }

    if (clearSubsession) {
      this._subsessionStartActiveTicks = this._sessionActiveTicks;
    }

    ret.activeTicks = activeTicks;

    return ret;
  },

  /**
   * Get the type of the dataset that needs to be collected, based on the preferences.
   * @return {Integer} A value from nsITelemetry.DATASET_*.
   */
  getDatasetType() {
    return Telemetry.canRecordExtended ? Ci.nsITelemetry.DATASET_RELEASE_CHANNEL_OPTIN
                                       : Ci.nsITelemetry.DATASET_RELEASE_CHANNEL_OPTOUT;
  },

  getHistograms: function getHistograms(clearSubsession) {
    let hls = Telemetry.snapshotHistograms(this.getDatasetType(), clearSubsession);
    return TelemetryUtils.packHistograms(hls, this._testing);
  },

  getKeyedHistograms(clearSubsession) {
    let khs = Telemetry.snapshotKeyedHistograms(this.getDatasetType(), clearSubsession);
    return TelemetryUtils.packKeyedHistograms(khs, this._testing);
  },

  /**
   * Get a snapshot of the scalars and clear them.
   * @param {subsession} If true, then we collect the data for a subsession.
   * @param {clearSubsession} If true, we  need to clear the subsession.
   * @param {keyed} Take a snapshot of keyed or non keyed scalars.
   * @return {Object} The scalar data as a Javascript object, including the
   *         data from child processes, in the following format:
   *            {'content': { 'scalarName': ... }, 'gpu': { ... } }
   */
  getScalars(subsession, clearSubsession, keyed) {
    if (!subsession) {
      // We only support scalars for subsessions.
      this._log.trace("getScalars - We only support scalars in subsessions.");
      return {};
    }

    let scalarsSnapshot = keyed ?
      Telemetry.snapshotKeyedScalars(this.getDatasetType(), clearSubsession) :
      Telemetry.snapshotScalars(this.getDatasetType(), clearSubsession);

    // Don't return the test scalars.
    let ret = {};
    for (let processName in scalarsSnapshot) {
      for (let name in scalarsSnapshot[processName]) {
        if (name.startsWith("telemetry.test") && !this._testing) {
          continue;
        }
        // Finally arrange the data in the returned object.
        if (!(processName in ret)) {
          ret[processName] = {};
        }
        ret[processName][name] = scalarsSnapshot[processName][name];
      }
    }

    return ret;
  },

  /**
   * Descriptive metadata
   *
   * @param  reason
   *         The reason for the telemetry ping, this will be included in the
   *         returned metadata,
   * @return The metadata as a JS object
   */
  getMetadata: function getMetadata(reason) {
    const sessionStartDate = Utils.toLocalTimeISOString(Utils.truncateToHours(this._sessionStartDate));
    const subsessionStartDate = Utils.toLocalTimeISOString(Utils.truncateToHours(this._subsessionStartDate));
    const monotonicNow = Policy.monotonicNow();

    let ret = {
      reason,
      revision: AppConstants.SOURCE_REVISION_URL,

      // Date.getTimezoneOffset() unintuitively returns negative values if we are ahead of
      // UTC and vice versa (e.g. -60 for UTC+1). We invert the sign here.
      timezoneOffset: -this._subsessionStartDate.getTimezoneOffset(),
      previousBuildId: this._previousBuildId,

      sessionId: this._sessionId,
      subsessionId: this._subsessionId,
      previousSessionId: this._previousSessionId,
      previousSubsessionId: this._previousSubsessionId,

      subsessionCounter: this._subsessionCounter,
      profileSubsessionCounter: this._profileSubsessionCounter,

      sessionStartDate,
      subsessionStartDate,

      // Compute the session and subsession length in seconds.
      // We use monotonic clocks as Date() is affected by jumping clocks (leading
      // to negative lengths and other issues).
      sessionLength: Math.floor(monotonicNow / 1000),
      subsessionLength:
        Math.floor((monotonicNow - this._subsessionStartTimeMonotonic) / 1000),
    };

    // TODO: Remove this when bug 1201837 lands.
    if (this._addons)
      ret.addons = this._addons;

    // TODO: Remove this when bug 1201837 lands.
    let flashVersion = this.getFlashVersion();
    if (flashVersion)
      ret.flashVersion = flashVersion;

    return ret;
  },

  /**
   * Pull values from about:memory into corresponding histograms
   */
  gatherMemory: function gatherMemory() {
    let mgr;
    try {
      mgr = Cc["@mozilla.org/memory-reporter-manager;1"].
            getService(Ci.nsIMemoryReporterManager);
    } catch (e) {
      // OK to skip memory reporters in xpcshell
      return;
    }

    let histogram = Telemetry.getHistogramById("TELEMETRY_MEMORY_REPORTER_MS");
    let startTime = new Date();

    // Get memory measurements from distinguished amount attributes.  We used
    // to measure "explicit" too, but it could cause hangs, and the data was
    // always really noisy anyway.  See bug 859657.
    //
    // test_TelemetryController.js relies on some of these histograms being
    // here.  If you remove any of the following histograms from here, you'll
    // have to modify test_TelemetryController.js:
    //
    //   * MEMORY_JS_GC_HEAP, and
    //   * MEMORY_JS_COMPARTMENTS_SYSTEM.
    //
    // The distinguished amount attribute names don't match the telemetry id
    // names in some cases due to a combination of (a) historical reasons, and
    // (b) the fact that we can't change telemetry id names without breaking
    // data continuity.
    //
    let boundHandleMemoryReport = this.handleMemoryReport.bind(this);
    let h = (id, units, amountName) => {
      try {
        // If mgr[amountName] throws an exception, just move on -- some amounts
        // aren't available on all platforms.  But if the attribute simply
        // isn't present, that indicates the distinguished amounts have changed
        // and this file hasn't been updated appropriately.
        let amount = mgr[amountName];
        if (amount === undefined) {
          this._log.error("gatherMemory - telemetry accessed an unknown distinguished amount");
        }
        boundHandleMemoryReport(id, units, amount);
      } catch (e) {
      }
    };
    let b = (id, n) => h(id, Ci.nsIMemoryReporter.UNITS_BYTES, n);
    let c = (id, n) => h(id, Ci.nsIMemoryReporter.UNITS_COUNT, n);
    let cc = (id, n) => h(id, Ci.nsIMemoryReporter.UNITS_COUNT_CUMULATIVE, n);
    let p = (id, n) => h(id, Ci.nsIMemoryReporter.UNITS_PERCENTAGE, n);

    // GHOST_WINDOWS is opt-out as of Firefox 55
    c("GHOST_WINDOWS", "ghostWindows");

    if (!Telemetry.canRecordExtended) {
      return;
    }

    b("MEMORY_VSIZE", "vsize");
    if (!Services.appinfo.is64Bit || AppConstants.platform !== "win") {
      b("MEMORY_VSIZE_MAX_CONTIGUOUS", "vsizeMaxContiguous");
    }
    b("MEMORY_RESIDENT_FAST", "residentFast");
    b("MEMORY_UNIQUE", "residentUnique");
    p("MEMORY_HEAP_OVERHEAD_FRACTION", "heapOverheadFraction");
    b("MEMORY_JS_GC_HEAP", "JSMainRuntimeGCHeap");
    c("MEMORY_JS_COMPARTMENTS_SYSTEM", "JSMainRuntimeRealmsSystem");
    c("MEMORY_JS_COMPARTMENTS_USER", "JSMainRuntimeRealmsUser");
    b("MEMORY_IMAGES_CONTENT_USED_UNCOMPRESSED", "imagesContentUsedUncompressed");
    b("MEMORY_STORAGE_SQLITE", "storageSQLite");
    cc("LOW_MEMORY_EVENTS_VIRTUAL", "lowMemoryEventsVirtual");
    cc("LOW_MEMORY_EVENTS_COMMIT_SPACE", "lowMemoryEventsCommitSpace");
    cc("LOW_MEMORY_EVENTS_PHYSICAL", "lowMemoryEventsPhysical");
    cc("PAGE_FAULTS_HARD", "pageFaultsHard");

    try {
      mgr.getHeapAllocatedAsync(heapAllocated => {
        boundHandleMemoryReport("MEMORY_HEAP_ALLOCATED",
                                Ci.nsIMemoryReporter.UNITS_BYTES,
                                heapAllocated);
      });
    } catch (e) {
    }

    if (!Utils.isContentProcess && !this._totalMemoryTimeout) {
      // Only the chrome process should gather total memory
      // total = parent RSS + sum(child USS)
      this._totalMemory = mgr.residentFast;
      if (Services.ppmm.childCount > 1) {
        // Do not report If we time out waiting for the children to call
        this._totalMemoryTimeout = setTimeout(
          () => {
            this._totalMemoryTimeout = undefined;
            this._childrenToHearFrom.clear();
          },
          TOTAL_MEMORY_COLLECTOR_TIMEOUT);
        this._USSFromChildProcesses = [];
        this._childrenToHearFrom = new Set();
        for (let i = 1; i < Services.ppmm.childCount; i++) {
          let child = Services.ppmm.getChildAt(i);
          try {
            child.sendAsyncMessage(MESSAGE_TELEMETRY_GET_CHILD_USS, {id: this._nextTotalMemoryId});
            this._childrenToHearFrom.add(this._nextTotalMemoryId);
            this._nextTotalMemoryId++;
          } catch (ex) {
            // If a content process has just crashed, then attempting to send it
            // an async message will throw an exception.
            Cu.reportError(ex);
          }
        }
      } else {
        boundHandleMemoryReport(
          "MEMORY_TOTAL",
          Ci.nsIMemoryReporter.UNITS_BYTES,
          this._totalMemory);
      }
    }

    histogram.add(new Date() - startTime);
  },

  handleMemoryReport(id, units, amount, key) {
    let val;
    if (units == Ci.nsIMemoryReporter.UNITS_BYTES) {
      val = Math.floor(amount / 1024);
    } else if (units == Ci.nsIMemoryReporter.UNITS_PERCENTAGE) {
      // UNITS_PERCENTAGE amounts are 100x greater than their raw value.
      val = Math.floor(amount / 100);
    } else if (units == Ci.nsIMemoryReporter.UNITS_COUNT) {
      val = amount;
    } else if (units == Ci.nsIMemoryReporter.UNITS_COUNT_CUMULATIVE) {
      // If the reporter gives us a cumulative count, we'll report the
      // difference in its value between now and our previous ping.

      if (!(id in this._prevValues)) {
        // If this is the first time we're reading this reporter, store its
        // current value but don't report it in the telemetry ping, so we
        // ignore the effect startup had on the reporter.
        this._prevValues[id] = amount;
        return;
      }

      val = amount - this._prevValues[id];
      this._prevValues[id] = amount;
    } else {
      this._log.error("handleMemoryReport - Can't handle memory reporter with units " + units);
      return;
    }

    if (key) {
      Telemetry.getKeyedHistogramById(id).add(key, val);
      return;
    }

    Telemetry.getHistogramById(id).add(val);
  },

  /**
   * Get the current session's payload using the provided
   * simpleMeasurements and info, which are typically obtained by a call
   * to |this.getSimpleMeasurements| and |this.getMetadata|,
   * respectively.
   */
  assemblePayloadWithMeasurements(simpleMeasurements, info, reason, clearSubsession) {
    const isSubsession = IS_UNIFIED_TELEMETRY && !this._isClassicReason(reason);
    clearSubsession = IS_UNIFIED_TELEMETRY && clearSubsession;
    this._log.trace("assemblePayloadWithMeasurements - reason: " + reason +
                    ", submitting subsession data: " + isSubsession);

    // This allows wrapping data retrieval calls in a try-catch block so that
    // failures don't break the rest of the ping assembly.
    const protect = (fn, defaultReturn = null) => {
      try {
        return fn();
      } catch (ex) {
        this._log.error("assemblePayloadWithMeasurements - caught exception", ex);
        return defaultReturn;
      }
    };

    // Payload common to chrome and content processes.
    let payloadObj = {
      ver: PAYLOAD_VERSION,
      simpleMeasurements,
    };

    // Add extended set measurements common to chrome & content processes
    if (Telemetry.canRecordExtended) {
      payloadObj.log = [];
      payloadObj.webrtc = protect(() => Telemetry.webrtcStats);
    }

    if (Utils.isContentProcess) {
      return payloadObj;
    }

    // Additional payload for chrome process.
    let measurements = {
      histograms: protect(() => this.getHistograms(clearSubsession), {}),
      keyedHistograms: protect(() => this.getKeyedHistograms(clearSubsession), {}),
      scalars: protect(() => this.getScalars(isSubsession, clearSubsession), {}),
      keyedScalars: protect(() => this.getScalars(isSubsession, clearSubsession, true), {}),
    };

    let measurementsContainGPU = Object
      .keys(measurements)
      .some(key => "gpu" in measurements[key]);

    payloadObj.processes = {};
    let processTypes = ["parent", "content", "extension", "dynamic"];
    // Only include the GPU process if we've accumulated data for it.
    if (measurementsContainGPU) {
      processTypes.push("gpu");
    }

    // Collect per-process measurements.
    for (const processType of processTypes) {
      let processPayload = {};

      for (const key in measurements) {
        let payloadLoc = processPayload;
        // Parent histograms are added to the top-level payload object instead of the process payload.
        if (processType == "parent" && (key == "histograms" || key == "keyedHistograms")) {
          payloadLoc = payloadObj;
        }
        // The Dynamic process only collects scalars.
        if (processType == "dynamic" && key !== "scalars") {
          continue;
        }

        // Process measurements can be empty, set a default value.
        payloadLoc[key] = measurements[key][processType] || {};
      }

      // Add process measurements to payload.
      payloadObj.processes[processType] = processPayload;
    }

    payloadObj.info = info;

    // Add extended set measurements for chrome process.
    if (Telemetry.canRecordExtended) {
      payloadObj.slowSQL = protect(() => Telemetry.slowSQL);
      payloadObj.fileIOReports = protect(() => Telemetry.fileIOReports);
      payloadObj.lateWrites = protect(() => Telemetry.lateWrites);

      payloadObj.addonDetails = protect(() => AddonManagerPrivate.getTelemetryDetails());

      let clearUIsession = !(reason == REASON_GATHER_PAYLOAD || reason == REASON_GATHER_SUBSESSION_PAYLOAD);

      if (AppConstants.platform == "android") {
        payloadObj.UIMeasurements = protect(() => UITelemetry.getUIMeasurements(clearUIsession));
      }

      if (this._slowSQLStartup &&
          Object.keys(this._slowSQLStartup).length != 0 &&
          (Object.keys(this._slowSQLStartup.mainThread).length ||
           Object.keys(this._slowSQLStartup.otherThreads).length)) {
        payloadObj.slowSQLStartup = this._slowSQLStartup;
      }

      if (!this._isClassicReason(reason)) {
        payloadObj.processes.parent.gc = protect(() => GCTelemetry.entries("main", clearSubsession));
        payloadObj.processes.content.gc = protect(() => GCTelemetry.entries("content", clearSubsession));
      }

      // Adding captured stacks to the payload only if any exist and clearing
      // captures for this sub-session.
      let stacks = protect(() => Telemetry.snapshotCapturedStacks(true));
      if (stacks && ("captures" in stacks) && (stacks.captures.length > 0)) {
        payloadObj.processes.parent.capturedStacks = stacks;
      }
    }

    return payloadObj;
  },

  /**
   * Start a new subsession.
   */
  startNewSubsession() {
    this._subsessionStartDate = Policy.now();
    this._subsessionStartTimeMonotonic = Policy.monotonicNow();
    this._previousSubsessionId = this._subsessionId;
    this._subsessionId = Policy.generateSubsessionUUID();
    this._subsessionCounter++;
    this._profileSubsessionCounter++;
  },

  getSessionPayload: function getSessionPayload(reason, clearSubsession) {
    this._log.trace("getSessionPayload - reason: " + reason + ", clearSubsession: " + clearSubsession);

    let payload;
    try {
      const isMobile = (AppConstants.platform == "android");
      const isSubsession = isMobile ? false : !this._isClassicReason(reason);

      if (isMobile) {
        clearSubsession = false;
      }

      let measurements =
        this.getSimpleMeasurements(reason == REASON_SAVED_SESSION, isSubsession, clearSubsession);
      let info = !Utils.isContentProcess ? this.getMetadata(reason) : null;
      payload = this.assemblePayloadWithMeasurements(measurements, info, reason, clearSubsession);
    } catch (ex) {
      Telemetry.getHistogramById("TELEMETRY_ASSEMBLE_PAYLOAD_EXCEPTION").add(1);
      throw ex;
    } finally {
      if (!Utils.isContentProcess && clearSubsession) {
        this.startNewSubsession();
        // Persist session data to disk (don't wait until it completes).
        let sessionData = this._getSessionDataObject();
        TelemetryStorage.saveSessionData(sessionData);

        // Notify that there was a subsession split in the parent process. This is an
        // internal topic and is only meant for internal Telemetry usage.
        Services.obs.notifyObservers(null, "internal-telemetry-after-subsession-split");
      }
    }

    return payload;
  },

  /**
   * Send data to the server. Record success/send-time in histograms
   */
  send: function send(reason) {
    this._log.trace("send - Reason " + reason);
    // populate histograms one last time
    this.gatherMemory();

    const isSubsession = !this._isClassicReason(reason);
    let payload = this.getSessionPayload(reason, isSubsession);
    let options = {
      addClientId: true,
      addEnvironment: true,
    };
    return TelemetryController.submitExternalPing(getPingType(payload), payload, options);
  },

  /**
   * Attaches the needed observers during Telemetry early init, in the
   * chrome process.
   */
  attachEarlyObservers() {
    this.addObserver("sessionstore-windows-restored");
    if (AppConstants.platform === "android") {
      this.addObserver("application-background");
    }
    this.addObserver("xul-window-visible");

    // Attach the active-ticks related observers.
    this.addObserver("user-interaction-active");
    this.addObserver("user-interaction-inactive");
  },

  attachObservers: function attachObservers() {
    if (!this._initialized)
      return;
    this.addObserver("idle-daily");
    if (Telemetry.canRecordExtended) {
      this.addObserver(TOPIC_CYCLE_COLLECTOR_BEGIN);
    }
  },


  /**
   * Lightweight init function, called as soon as Firefox starts.
   */
  earlyInit(testing) {
    this._log.trace("earlyInit");

    this._initStarted = true;
    this._testing = testing;

    if (this._initialized && !testing) {
      this._log.error("earlyInit - already initialized");
      return;
    }

    if (!Telemetry.canRecordBase && !testing) {
      this._log.config("earlyInit - Telemetry recording is disabled, skipping Chrome process setup.");
      return;
    }

    // Generate a unique id once per session so the server can cope with duplicate
    // submissions, orphaning and other oddities. The id is shared across subsessions.
    this._sessionId = Policy.generateSessionUUID();
    this.startNewSubsession();
    // startNewSubsession sets |_subsessionStartDate| to the current date/time. Use
    // the very same value for |_sessionStartDate|.
    this._sessionStartDate = this._subsessionStartDate;

    annotateCrashReport(this._sessionId);

    // Record old value and update build ID preference if this is the first
    // run with a new build ID.
    let previousBuildId = Services.prefs.getStringPref(TelemetryUtils.Preferences.PreviousBuildID, null);
    let thisBuildID = Services.appinfo.appBuildID;
    // If there is no previousBuildId preference, we send null to the server.
    if (previousBuildId != thisBuildID) {
      this._previousBuildId = previousBuildId;
      Services.prefs.setStringPref(TelemetryUtils.Preferences.PreviousBuildID, thisBuildID);
    }

    this.attachEarlyObservers();

    Services.ppmm.addMessageListener(MESSAGE_TELEMETRY_USS, this);
  },

  /**
   * Does the "heavy" Telemetry initialization later on, so we
   * don't impact startup performance.
   * @return {Promise} Resolved when the initialization completes.
   */
  delayedInit() {
    this._log.trace("delayedInit");

    this._delayedInitTask = (async () => {
      try {
        this._initialized = true;

        await this._loadSessionData();
        // Update the session data to keep track of new subsessions created before
        // the initialization.
        await TelemetryStorage.saveSessionData(this._getSessionDataObject());

        this.attachObservers();
        this.gatherMemory();

        if (Telemetry.canRecordExtended) {
          GCTelemetry.init();
        }

        Telemetry.asyncFetchTelemetryData(function() {});

        if (IS_UNIFIED_TELEMETRY) {
          // Check for a previously written aborted session ping.
          await TelemetryController.checkAbortedSessionPing();

          // Write the first aborted-session ping as early as possible. Just do that
          // if we are not testing, since calling Telemetry.reset() will make a previous
          // aborted ping a pending ping.
          if (!this._testing) {
            await this._saveAbortedSessionPing();
          }

          // The last change date for the environment, used to throttle environment changes.
          this._lastEnvironmentChangeDate = Policy.monotonicNow();
          TelemetryEnvironment.registerChangeListener(ENVIRONMENT_CHANGE_LISTENER,
                                 (reason, data) => this._onEnvironmentChange(reason, data));

          // Start the scheduler.
          // We skip this if unified telemetry is off, so we don't
          // trigger the new unified ping types.
          TelemetryScheduler.init();
        }

        this._delayedInitTask = null;
      } catch (e) {
        this._delayedInitTask = null;
        throw e;
      }
    })();

    return this._delayedInitTask;
  },

  getOpenTabsCount: function getOpenTabsCount() {
    let tabCount = 0;

    for (let win of Services.wm.getEnumerator("navigator:browser")) {
      tabCount += win.gBrowser.tabs.length;
    }

    return tabCount;
  },

  /**
   * Initializes telemetry for a content process.
   */
  setupContentProcess: function setupContentProcess(testing) {
    this._log.trace("setupContentProcess");
    this._testing = testing;

    if (!Telemetry.canRecordBase) {
      this._log.trace("setupContentProcess - base recording is disabled, not initializing");
      return;
    }

    this.addObserver("content-child-shutdown");
    Services.cpmm.addMessageListener(MESSAGE_TELEMETRY_GET_CHILD_USS, this);

    let delayedTask = new DeferredTask(() => {
      this._initialized = true;

      this.attachObservers();
      this.gatherMemory();

      if (Telemetry.canRecordExtended) {
        GCTelemetry.init();
      }
    }, testing ? TELEMETRY_TEST_DELAY : TELEMETRY_DELAY,
    testing ? 0 : undefined);

    delayedTask.arm();
  },

  getFlashVersion: function getFlashVersion() {
    let host = Cc["@mozilla.org/plugin/host;1"].getService(Ci.nsIPluginHost);
    let tags = host.getPluginTags();

    for (let i = 0; i < tags.length; i++) {
      if (tags[i].name == "Shockwave Flash")
        return tags[i].version;
    }

    return null;
  },

  receiveMessage: function receiveMessage(message) {
    this._log.trace("receiveMessage - Message name " + message.name);
    switch (message.name) {
    case MESSAGE_TELEMETRY_USS:
    {
      // In parent process, receive the USS report from the child
      if (this._totalMemoryTimeout && this._childrenToHearFrom.delete(message.data.id)) {
        let uss = message.data.bytes;
        this._totalMemory += uss;
        this._USSFromChildProcesses.push(uss);
        if (this._childrenToHearFrom.size == 0) {
          clearTimeout(this._totalMemoryTimeout);
          this._totalMemoryTimeout = undefined;
          this.handleMemoryReport(
            "MEMORY_TOTAL",
            Ci.nsIMemoryReporter.UNITS_BYTES,
            this._totalMemory);

          let length = this._USSFromChildProcesses.length;
          if (length > 1) {
            // Mean of the USS of all the content processes.
            let mean = this._USSFromChildProcesses.reduce((a, b) => a + b, 0) / length;
            // Absolute error of USS for each content process, normalized by the mean (*100 to get it in percentage).
            // 20% means for a content process that it is using 20% more or 20% less than the mean.
            let diffs = this._USSFromChildProcesses.map(value => Math.floor(Math.abs(value - mean) * 100 / mean));
            let tabsCount = this.getOpenTabsCount();
            let key;
            if (tabsCount < 11) {
              key = "0 - 10 tabs";
            } else if (tabsCount < 501) {
              key = "11 - 500 tabs";
            } else {
              key = "more tabs";
            }

            diffs.forEach(value => {
              this.handleMemoryReport(
              "MEMORY_DISTRIBUTION_AMONG_CONTENT",
              Ci.nsIMemoryReporter.UNITS_COUNT,
              value,
              key);
            });

            // This notification is for testing only.
            Services.obs.notifyObservers(null, "gather-memory-telemetry-finished");
          }
          this._USSFromChildProcesses = undefined;
        }
      } else {
        this._log.trace("Child USS report was missed");
      }
      break;
    }
    case MESSAGE_TELEMETRY_GET_CHILD_USS:
    {
      // In child process, send the requested USS report
      this.sendContentProcessUSS(message.data.id);
      break;
    }
    default:
      throw new Error("Telemetry.receiveMessage: bad message name");
    }
  },

  sendContentProcessUSS: function sendContentProcessUSS(aMessageId) {
    this._log.trace("sendContentProcessUSS");

    let mgr;
    try {
      mgr = Cc["@mozilla.org/memory-reporter-manager;1"].
            getService(Ci.nsIMemoryReporterManager);
    } catch (e) {
      // OK to skip memory reporters in xpcshell
      return;
    }

    Services.cpmm.sendAsyncMessage(
      MESSAGE_TELEMETRY_USS,
      {bytes: mgr.residentUnique, id: aMessageId}
    );
  },

   /**
    * On Desktop: Save the "shutdown" ping to disk.
    * On Android: Save the "saved-session" ping to disk.
    * This needs to be called after TelemetrySend shuts down otherwise pings
    * would be sent instead of getting persisted to disk.
    */
  saveShutdownPings() {
    this._log.trace("saveShutdownPings");

    // We append the promises to this list and wait
    // on all pings to be saved after kicking off their collection.
    let p = [];

    if (IS_UNIFIED_TELEMETRY) {
      let shutdownPayload = this.getSessionPayload(REASON_SHUTDOWN, false);

      // Only send the shutdown ping using the pingsender from the second
      // browsing session on, to mitigate issues with "bot" profiles (see bug 1354482).
      const sendOnThisSession =
        Services.prefs.getBoolPref(Utils.Preferences.ShutdownPingSenderFirstSession, false) ||
        !TelemetryReportingPolicy.isFirstRun();
      let sendWithPingsender = Services.prefs.getBoolPref(TelemetryUtils.Preferences.ShutdownPingSender, false) &&
                               sendOnThisSession;

      let options = {
        addClientId: true,
        addEnvironment: true,
        usePingSender: sendWithPingsender,
      };
      p.push(TelemetryController.submitExternalPing(getPingType(shutdownPayload), shutdownPayload, options)
                                .catch(e => this._log.error("saveShutdownPings - failed to submit shutdown ping", e)));

      // Send a duplicate of first-shutdown pings as a new ping type, in order to properly
      // evaluate first session profiles (see bug 1390095).
      const sendFirstShutdownPing =
        Services.prefs.getBoolPref(Utils.Preferences.ShutdownPingSender, false) &&
        Services.prefs.getBoolPref(Utils.Preferences.FirstShutdownPingEnabled, false) &&
        TelemetryReportingPolicy.isFirstRun();

      if (sendFirstShutdownPing) {
        let options = {
            addClientId: true,
            addEnvironment: true,
            usePingSender: true,
          };
        p.push(TelemetryController.submitExternalPing("first-shutdown", shutdownPayload, options)
                                  .catch(e => this._log.error("saveShutdownPings - failed to submit first shutdown ping", e)));
      }
    }

    if (AppConstants.platform == "android" && Telemetry.canRecordExtended) {
      let payload = this.getSessionPayload(REASON_SAVED_SESSION, false);

      let options = {
        addClientId: true,
        addEnvironment: true,
      };
      p.push(TelemetryController.submitExternalPing(getPingType(payload), payload, options)
                                .catch(e => this._log.error("saveShutdownPings - failed to submit saved-session ping", e)));
    }

    // Wait on pings to be saved.
    return Promise.all(p);
  },

  testSavePendingPing() {
    let payload = this.getSessionPayload(REASON_SAVED_SESSION, false);
    let options = {
      addClientId: true,
      addEnvironment: true,
      overwrite: true,
    };
    return TelemetryController.addPendingPing(getPingType(payload), payload, options);
  },

  /**
   * Do some shutdown work that is common to all process types.
   */
  uninstall() {
    for (let topic of this._observedTopics) {
      try {
        // Tests may flip Telemetry.canRecordExtended on and off. It can be the case
        // that the observer TOPIC_CYCLE_COLLECTOR_BEGIN was not added.
        this.removeObserver(topic);
      } catch (e) {
        this._log.warn("uninstall - Failed to remove " + topic, e);
      }
    }

    GCTelemetry.shutdown();
  },

  getPayload: function getPayload(reason, clearSubsession) {
    this._log.trace("getPayload - clearSubsession: " + clearSubsession);
    reason = reason || REASON_GATHER_PAYLOAD;
    // This function returns the current Telemetry payload to the caller.
    // We only gather startup info once.
    if (Object.keys(this._slowSQLStartup).length == 0) {
      this._slowSQLStartup = Telemetry.slowSQL;
    }
    this.gatherMemory();
    return this.getSessionPayload(reason, clearSubsession);
  },

  gatherStartup: function gatherStartup() {
    this._log.trace("gatherStartup");
    let counters = processInfo.getCounters();
    if (counters) {
      [this._startupIO.startupSessionRestoreReadBytes,
        this._startupIO.startupSessionRestoreWriteBytes] = counters;
    }
    this._slowSQLStartup = Telemetry.slowSQL;
  },

  setAddOns: function setAddOns(aAddOns) {
    this._addons = aAddOns;
  },

  testPing: function testPing() {
    return this.send(REASON_TEST_PING);
  },

  /**
   * Tracks the number of "ticks" the user was active in.
   */
  _onActiveTick(aUserActive) {
    const needsUpdate = aUserActive && this._isUserActive;
    this._isUserActive = aUserActive;

    // Don't count the first active tick after we get out of
    // inactivity, because it is just the start of this active tick.
    if (needsUpdate) {
      this._sessionActiveTicks++;
      Telemetry.scalarAdd("browser.engagement.active_ticks", 1);
    }
  },

  /**
   * This observer drives telemetry.
   */
  observe(aSubject, aTopic, aData) {
    // Prevent the cycle collector begin topic from cluttering the log.
    if (aTopic != TOPIC_CYCLE_COLLECTOR_BEGIN) {
      this._log.trace("observe - " + aTopic + " notified.");
    }

    switch (aTopic) {
    case "content-child-shutdown":
      // content-child-shutdown is only registered for content processes.
      this.uninstall();
      Telemetry.flushBatchedChildTelemetry();
      break;
    case TOPIC_CYCLE_COLLECTOR_BEGIN:
      let now = new Date();
      if (!gLastMemoryPoll
          || (TELEMETRY_INTERVAL <= now - gLastMemoryPoll)) {
        gLastMemoryPoll = now;

        this._log.trace("Dispatching idle gatherMemory task");
        Services.tm.idleDispatchToMainThread(() => {
          this._log.trace("Running idle gatherMemory task");
          this.gatherMemory();
          return true;
        });
      }
      break;
    case "xul-window-visible":
      this.removeObserver("xul-window-visible");
      var counters = processInfo.getCounters();
      if (counters) {
        [this._startupIO.startupWindowVisibleReadBytes,
          this._startupIO.startupWindowVisibleWriteBytes] = counters;
      }
      break;
    case "sessionstore-windows-restored":
      this.removeObserver("sessionstore-windows-restored");
      // Check whether debugger was attached during startup
      let debugService = Cc["@mozilla.org/xpcom/debug;1"].getService(Ci.nsIDebug2);
      gWasDebuggerAttached = debugService.isDebuggerAttached;
      this.gatherStartup();
      break;
    case "idle-daily":
      // Enqueue to main-thread, otherwise components may be inited by the
      // idle-daily category and miss the gather-telemetry notification.
      Services.tm.dispatchToMainThread((function() {
        // Notify that data should be gathered now.
        // TODO: We are keeping this behaviour for now but it will be removed as soon as
        // bug 1127907 lands.
        Services.obs.notifyObservers(null, "gather-telemetry");
      }));
      break;

    case "application-background":
      if (AppConstants.platform !== "android") {
        break;
      }
      // On Android, we can get killed without warning once we are in the background,
      // but we may also submit data and/or come back into the foreground without getting
      // killed. To deal with this, we save the current session data to file when we are
      // put into the background. This handles the following post-backgrounding scenarios:
      // 1) We are killed immediately. In this case the current session data (which we
      //    save to a file) will be loaded and submitted on a future run.
      // 2) We submit the data while in the background, and then are killed. In this case
      //    the file that we saved will be deleted by the usual process in
      //    finishPingRequest after it is submitted.
      // 3) We submit the data, and then come back into the foreground. Same as case (2).
      // 4) We do not submit the data, but come back into the foreground. In this case
      //    we have the option of either deleting the file that we saved (since we will either
      //    send the live data while in the foreground, or create the file again on the next
      //    backgrounding), or not (in which case we will delete it on submit, or overwrite
      //    it on the next backgrounding). Not deleting it is faster, so that's what we do.
      let payload = this.getSessionPayload(REASON_SAVED_SESSION, false);
      let options = {
        addClientId: true,
        addEnvironment: true,
        overwrite: true,
      };
      TelemetryController.addPendingPing(getPingType(payload), payload, options);
      break;
    case "user-interaction-active":
      this._onActiveTick(true);
      break;
    case "user-interaction-inactive":
      this._onActiveTick(false);
      break;
    }
    return undefined;
  },

  /**
   * This tells TelemetrySession to uninitialize and save any pending pings.
   */
  shutdownChromeProcess() {
    this._log.trace("shutdownChromeProcess");

    let cleanup = () => {
      if (IS_UNIFIED_TELEMETRY) {
        TelemetryEnvironment.unregisterChangeListener(ENVIRONMENT_CHANGE_LISTENER);
        TelemetryScheduler.shutdown();
      }
      this.uninstall();

      let reset = () => {
        this._initStarted = false;
        this._initialized = false;
      };

      return (async () => {
        await this.saveShutdownPings();

        if (IS_UNIFIED_TELEMETRY) {
          await TelemetryController.removeAbortedSessionPing();
        }

        reset();
      })();
    };

    // We can be in one the following states here:
    // 1) delayedInit was never called
    // or it was called and
    //   2) _delayedInitTask is running now.
    //   3) _delayedInitTask finished running already.

    // This handles 1).
    if (!this._initStarted) {
      return Promise.resolve();
     }

    // This handles 3).
    if (!this._delayedInitTask) {
      // We already ran the delayed initialization.
      return cleanup();
     }

     // This handles 2).
     return this._delayedInitTask.then(cleanup);
   },

  /**
   * Gather and send a daily ping.
   * @return {Promise} Resolved when the ping is sent.
   */
  _sendDailyPing() {
    this._log.trace("_sendDailyPing");
    let payload = this.getSessionPayload(REASON_DAILY, true);

    let options = {
      addClientId: true,
      addEnvironment: true,
    };

    let promise = TelemetryController.submitExternalPing(getPingType(payload), payload, options);

    // Also save the payload as an aborted session. If we delay this, aborted-session can
    // lag behind for the profileSubsessionCounter and other state, complicating analysis.
    if (IS_UNIFIED_TELEMETRY) {
      this._saveAbortedSessionPing(payload)
          .catch(e => this._log.error("_sendDailyPing - Failed to save the aborted session ping", e));
    }

    return promise;
  },

  /** Loads session data from the session data file.
   * @return {Promise<object>} A promise which is resolved with an object when
   *                            loading has completed, with null otherwise.
   */
  async _loadSessionData() {
    let data = await TelemetryStorage.loadSessionData();

    if (!data) {
      return null;
    }

    if (!("profileSubsessionCounter" in data) ||
        !(typeof(data.profileSubsessionCounter) == "number") ||
        !("subsessionId" in data) || !("sessionId" in data)) {
      this._log.error("_loadSessionData - session data is invalid");
      Telemetry.getHistogramById("TELEMETRY_SESSIONDATA_FAILED_VALIDATION").add(1);
      return null;
    }

    this._previousSessionId = data.sessionId;
    this._previousSubsessionId = data.subsessionId;
    // Add |_subsessionCounter| to the |_profileSubsessionCounter| to account for
    // new subsession while loading still takes place. This will always be exactly
    // 1 - the current subsessions.
    this._profileSubsessionCounter = data.profileSubsessionCounter +
                                     this._subsessionCounter;
    // If we don't have this flag in the state file, it means that this is an old profile.
    // We don't want to send the "new-profile" ping on new profile, so se this to true.
    this._newProfilePingSent = ("newProfilePingSent" in data) ? data.newProfilePingSent : true;
    return data;
  },

  /**
   * Get the session data object to serialise to disk.
   */
  _getSessionDataObject() {
    return {
      sessionId: this._sessionId,
      subsessionId: this._subsessionId,
      profileSubsessionCounter: this._profileSubsessionCounter,
      newProfilePingSent: this._newProfilePingSent,
    };
  },

  _onEnvironmentChange(reason, oldEnvironment) {
    this._log.trace("_onEnvironmentChange", reason);

    let now = Policy.monotonicNow();
    let timeDelta = now - this._lastEnvironmentChangeDate;
    if (timeDelta <= MIN_SUBSESSION_LENGTH_MS) {
      this._log.trace(`_onEnvironmentChange - throttling; last change was ${Math.round(timeDelta / 1000)}s ago.`);
      return;
    }

    this._lastEnvironmentChangeDate = now;
    let payload = this.getSessionPayload(REASON_ENVIRONMENT_CHANGE, true);
    TelemetryScheduler.reschedulePings(REASON_ENVIRONMENT_CHANGE, payload);

    let options = {
      addClientId: true,
      addEnvironment: true,
      overrideEnvironment: oldEnvironment,
    };
    TelemetryController.submitExternalPing(getPingType(payload), payload, options);
  },

  _isClassicReason(reason) {
    const classicReasons = [
      REASON_SAVED_SESSION,
      REASON_GATHER_PAYLOAD,
      REASON_TEST_PING,
    ];
    return classicReasons.includes(reason);
  },

  /**
   * Get an object describing the current state of this module for AsyncShutdown diagnostics.
   */
  _getState() {
    return {
      initialized: this._initialized,
      initStarted: this._initStarted,
      haveDelayedInitTask: !!this._delayedInitTask,
    };
  },

  /**
   * Saves the aborted session ping to disk.
   * @param {Object} [aProvidedPayload=null] A payload object to be used as an aborted
   *                 session ping. The reason of this payload is changed to aborted-session.
   *                 If not provided, a new payload is gathered.
   */
  _saveAbortedSessionPing(aProvidedPayload = null) {
    this._log.trace("_saveAbortedSessionPing");

    let payload = null;
    if (aProvidedPayload) {
      payload = Cu.cloneInto(aProvidedPayload, myScope);
      // Overwrite the original reason.
      payload.info.reason = REASON_ABORTED_SESSION;
    } else {
      payload = this.getSessionPayload(REASON_ABORTED_SESSION, false);
    }

    return TelemetryController.saveAbortedSessionPing(payload);
  },

  async markNewProfilePingSent() {
    this._log.trace("markNewProfilePingSent");
    this._newProfilePingSent = true;
    return TelemetryStorage.saveSessionData(this._getSessionDataObject());
  },
};
