/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");
ChromeUtils.import("resource://gre/modules/Services.jsm");
ChromeUtils.import("resource://gre/modules/Troubleshoot.jsm");
ChromeUtils.import("resource://gre/modules/ResetProfile.jsm");
ChromeUtils.import("resource://gre/modules/AppConstants.jsm");

ChromeUtils.defineModuleGetter(this, "PluralForm",
                               "resource://gre/modules/PluralForm.jsm");
ChromeUtils.defineModuleGetter(this, "PlacesDBUtils",
                               "resource://gre/modules/PlacesDBUtils.jsm");

window.addEventListener("load", function onload(event) {
  try {
  window.removeEventListener("load", onload);
  Troubleshoot.snapshot(function(snapshot) {
    for (let prop in snapshotFormatters)
      snapshotFormatters[prop](snapshot[prop]);
  });
  populateActionBox();
  setupEventListeners();
  } catch (e) {
    Cu.reportError("stack of load error for about:support: " + e + ": " + e.stack);
  }
});

// Each property in this object corresponds to a property in Troubleshoot.jsm's
// snapshot data.  Each function is passed its property's corresponding data,
// and it's the function's job to update the page with it.
var snapshotFormatters = {

  application: function application(data) {
    let strings = stringBundle();
    $("application-box").textContent = data.name;
    $("useragent-box").textContent = data.userAgent;
    $("os-box").textContent = data.osVersion;
    $("supportLink").href = data.supportURL;
    let version = AppConstants.MOZ_APP_VERSION_DISPLAY;
    if (data.vendor)
      version += " (" + data.vendor + ")";
    $("version-box").textContent = version;
    $("buildid-box").textContent = data.buildID;
    if (data.updateChannel)
      $("updatechannel-box").textContent = data.updateChannel;
    $("profile-dir-box").textContent = Services.dirsvc.get("ProfD", Ci.nsIFile).path;

    let statusText = strings.GetStringFromName("multiProcessStatus.unknown");

    // Whitelist of known values with string descriptions:
    switch (data.autoStartStatus) {
      case 0:
      case 1:
      case 2:
      case 4:
      case 6:
      case 7:
      case 8:
        statusText = strings.GetStringFromName("multiProcessStatus." + data.autoStartStatus);
        break;

      case 10:
        statusText = (Services.appinfo.OS == "Darwin" ? "OS X 10.6 - 10.8" : "Windows XP");
        break;
    }

    $("multiprocess-box").textContent = strings.formatStringFromName("multiProcessWindows",
      [data.numRemoteWindows, data.numTotalWindows, statusText], 3);

    if (data.remoteAutoStart) {
      $("contentprocesses-box").textContent = data.currentContentProcesses +
                                              "/" +
                                              data.maxContentProcesses;
    } else {
      $("contentprocesses-row").hidden = true;
    }

    if (Services.policies) {
      let policiesText = "";
      switch (data.policiesStatus) {
        case Services.policies.INACTIVE:
          policiesText = strings.GetStringFromName("policies.inactive");
          break;

        case Services.policies.ACTIVE:
          policiesText = strings.GetStringFromName("policies.active");
          break;

        default:
          policiesText = strings.GetStringFromName("policies.error");
          break;
      }

      if (data.policiesStatus != Services.policies.INACTIVE) {
        let activePolicies = $.new("a", policiesText, null, {href: "about:policies"});
        $("policies-status").appendChild(activePolicies);
      } else {
        $("policies-status").textContent = policiesText;
      }
    } else {
      $("policies-status-row").hidden = true;
    }

    let keyGoogleFound = data.keyGoogleFound ? "found" : "missing";
    $("key-google-box").textContent = strings.GetStringFromName(keyGoogleFound);

    let keyMozillaFound = data.keyMozillaFound ? "found" : "missing";
    $("key-mozilla-box").textContent = strings.GetStringFromName(keyMozillaFound);

    $("safemode-box").textContent = data.safeMode;
  },

  crashes: function crashes(data) {
    if (!AppConstants.MOZ_CRASHREPORTER)
      return;

    let strings = stringBundle();
    let daysRange = Troubleshoot.kMaxCrashAge / (24 * 60 * 60 * 1000);
    $("crashes-title").textContent =
      PluralForm.get(daysRange, strings.GetStringFromName("crashesTitle"))
                .replace("#1", daysRange);
    let reportURL;
    try {
      reportURL = Services.prefs.getCharPref("breakpad.reportURL");
      // Ignore any non http/https urls
      if (!/^https?:/i.test(reportURL))
        reportURL = null;
    } catch (e) { }
    if (!reportURL) {
      $("crashes-noConfig").style.display = "block";
      $("crashes-noConfig").classList.remove("no-copy");
      return;
    }
    $("crashes-allReports").style.display = "block";
    $("crashes-allReports").classList.remove("no-copy");

    if (data.pending > 0) {
      $("crashes-allReportsWithPending").textContent =
        PluralForm.get(data.pending, strings.GetStringFromName("pendingReports"))
                  .replace("#1", data.pending);
    }

    let dateNow = new Date();
    $.append($("crashes-tbody"), data.submitted.map(function(crash) {
      let date = new Date(crash.date);
      let timePassed = dateNow - date;
      let formattedDate;
      if (timePassed >= 24 * 60 * 60 * 1000) {
        let daysPassed = Math.round(timePassed / (24 * 60 * 60 * 1000));
        let daysPassedString = strings.GetStringFromName("crashesTimeDays");
        formattedDate = PluralForm.get(daysPassed, daysPassedString)
                                  .replace("#1", daysPassed);
      } else if (timePassed >= 60 * 60 * 1000) {
        let hoursPassed = Math.round(timePassed / (60 * 60 * 1000));
        let hoursPassedString = strings.GetStringFromName("crashesTimeHours");
        formattedDate = PluralForm.get(hoursPassed, hoursPassedString)
                                  .replace("#1", hoursPassed);
      } else {
        let minutesPassed = Math.max(Math.round(timePassed / (60 * 1000)), 1);
        let minutesPassedString = strings.GetStringFromName("crashesTimeMinutes");
        formattedDate = PluralForm.get(minutesPassed, minutesPassedString)
                                  .replace("#1", minutesPassed);
      }
      return $.new("tr", [
        $.new("td", [
          $.new("a", crash.id, null, {href: reportURL + crash.id})
        ]),
        $.new("td", formattedDate)
      ]);
    }));
  },

  extensions: function extensions(data) {
    $.append($("extensions-tbody"), data.map(function(extension) {
      return $.new("tr", [
        $.new("td", extension.name),
        $.new("td", extension.version),
        $.new("td", extension.isActive),
        $.new("td", extension.id),
      ]);
    }));
  },

  securitySoftware: function securitySoftware(data) {
    if (!AppConstants.isPlatformAndVersionAtLeast("win", "6.2")) {
      $("security-software-title").hidden = true;
      $("security-software-table").hidden = true;
      return;
    }

    $("security-software-antivirus").textContent = data.registeredAntiVirus;
    $("security-software-antispyware").textContent = data.registeredAntiSpyware;
    $("security-software-firewall").textContent = data.registeredFirewall;
  },

  features: function features(data) {
    $.append($("features-tbody"), data.map(function(feature) {
      return $.new("tr", [
        $.new("td", feature.name),
        $.new("td", feature.version),
        $.new("td", feature.id),
      ]);
    }));
  },

  modifiedPreferences: function modifiedPreferences(data) {
    $.append($("prefs-tbody"), sortedArrayFromObject(data).map(
      function([name, value]) {
        return $.new("tr", [
          $.new("td", name, "pref-name"),
          // Very long preference values can cause users problems when they
          // copy and paste them into some text editors.  Long values generally
          // aren't useful anyway, so truncate them to a reasonable length.
          $.new("td", String(value).substr(0, 120), "pref-value"),
        ]);
      }
    ));
  },

  lockedPreferences: function lockedPreferences(data) {
    $.append($("locked-prefs-tbody"), sortedArrayFromObject(data).map(
      function([name, value]) {
        return $.new("tr", [
          $.new("td", name, "pref-name"),
          $.new("td", String(value).substr(0, 120), "pref-value"),
        ]);
      }
    ));
  },

  graphics: function graphics(data) {
    let strings = stringBundle();

    function localizedMsg(msgArray) {
      let nameOrMsg = msgArray.shift();
      if (msgArray.length) {
        // formatStringFromName logs an NS_ASSERTION failure otherwise that says
        // "use GetStringFromName".  Lame.
        try {
          return strings.formatStringFromName(nameOrMsg, msgArray,
                                              msgArray.length);
        } catch (err) {
          // Throws if nameOrMsg is not a name in the bundle.  This shouldn't
          // actually happen though, since msgArray.length > 1 => nameOrMsg is a
          // name in the bundle, not a message, and the remaining msgArray
          // elements are parameters.
          return nameOrMsg;
        }
      }
      try {
        return strings.GetStringFromName(nameOrMsg);
      } catch (err) {
        // Throws if nameOrMsg is not a name in the bundle.
      }
      return nameOrMsg;
    }

    // Read APZ info out of data.info, stripping it out in the process.
    let apzInfo = [];
    let formatApzInfo = function(info) {
      let out = [];
      for (let type of ["Wheel", "Touch", "Drag", "Keyboard", "Autoscroll"]) {
        let key = "Apz" + type + "Input";

        if (!(key in info))
          continue;

        delete info[key];

        let message = localizedMsg([type.toLowerCase() + "Enabled"]);
        out.push(message);
      }

      return out;
    };

    // Create a <tr> element with key and value columns.
    //
    // @key      Text in the key column. Localized automatically, unless starts with "#".
    // @value    Text in the value column. Not localized.
    function buildRow(key, value) {
      let title;
      if (key[0] == "#") {
        title = key.substr(1);
      } else {
        try {
          title = strings.GetStringFromName(key);
        } catch (e) {
          title = key;
        }
      }
      let td = $.new("td", value);
      td.style["white-space"] = "pre-wrap";

      return $.new("tr", [
        $.new("th", title, "column"),
        td,
      ]);
    }

    // @where    The name in "graphics-<name>-tbody", of the element to append to.
    // @trs      Array of row elements.
    function addRows(where, trs) {
      $.append($("graphics-" + where + "-tbody"), trs);
    }

    // Build and append a row.
    //
    // @where    The name in "graphics-<name>-tbody", of the element to append to.
    function addRow(where, key, value) {
      addRows(where, [buildRow(key, value)]);
    }
    if (data.clearTypeParameters !== undefined) {
      addRow("diagnostics", "clearTypeParameters", data.clearTypeParameters);
    }
    if ("info" in data) {
      apzInfo = formatApzInfo(data.info);

      let trs = sortedArrayFromObject(data.info).map(function([prop, val]) {
        return $.new("tr", [
          $.new("th", prop, "column"),
          $.new("td", String(val)),
        ]);
      });
      addRows("diagnostics", trs);

      delete data.info;
    }

    let windowUtils = window.windowUtils;
    let gpuProcessPid = windowUtils.gpuProcessPid;

    if (gpuProcessPid != -1) {
      let gpuProcessKillButton = null;
      if (AppConstants.NIGHTLY_BUILD || AppConstants.MOZ_DEV_EDITION) {
        gpuProcessKillButton = $.new("button");

        gpuProcessKillButton.addEventListener("click", function() {
          windowUtils.terminateGPUProcess();
        });

        gpuProcessKillButton.textContent = strings.GetStringFromName("gpuProcessKillButton");
      }

      addRow("diagnostics", "GPUProcessPid", gpuProcessPid);
      if (gpuProcessKillButton) {
        addRow("diagnostics", "GPUProcess", [gpuProcessKillButton]);
      }
    }

    if ((AppConstants.NIGHTLY_BUILD || AppConstants.MOZ_DEV_EDITION) && AppConstants.platform != "macosx") {
      let gpuDeviceResetButton = $.new("button");

      gpuDeviceResetButton.addEventListener("click", function() {
        windowUtils.triggerDeviceReset();
      });

      gpuDeviceResetButton.textContent = strings.GetStringFromName("gpuDeviceResetButton");
      addRow("diagnostics", "Device Reset", [gpuDeviceResetButton]);
    }

    // graphics-failures-tbody tbody
    if ("failures" in data) {
      // If indices is there, it should be the same length as failures,
      // (see Troubleshoot.jsm) but we check anyway:
      if ("indices" in data && data.failures.length == data.indices.length) {
        let combined = [];
        for (let i = 0; i < data.failures.length; i++) {
          let assembled = assembleFromGraphicsFailure(i, data);
          combined.push(assembled);
        }
        combined.sort(function(a, b) {
            if (a.index < b.index) return -1;
            if (a.index > b.index) return 1;
            return 0;
        });
        $.append($("graphics-failures-tbody"),
                 combined.map(function(val) {
                   return $.new("tr", [$.new("th", val.header, "column"),
                                       $.new("td", val.message)]);
                 }));
        delete data.indices;
      } else {
        $.append($("graphics-failures-tbody"),
          [$.new("tr", [$.new("th", "LogFailure", "column"),
                        $.new("td", data.failures.map(function(val) {
                          return $.new("p", val);
                       }))])]);
      }
    } else {
      $("graphics-failures-tbody").style.display = "none";
    }

    // Add a new row to the table, and take the key (or keys) out of data.
    //
    // @where        Table section to add to.
    // @key          Data key to use.
    // @colKey       The localization key to use, if different from key.
    function addRowFromKey(where, key, colKey) {
      if (!(key in data))
        return;
      colKey = colKey || key;

      let value;
      let messageKey = key + "Message";
      if (messageKey in data) {
        value = localizedMsg(data[messageKey]);
        delete data[messageKey];
      } else {
        value = data[key];
      }
      delete data[key];

      if (value) {
        addRow(where, colKey, value);
      }
    }

    // graphics-features-tbody
    let compositor = "";
    if (data.windowLayerManagerRemote) {
      compositor = data.windowLayerManagerType;
      if (data.windowUsingAdvancedLayers) {
        compositor += " (Advanced Layers)";
      }
    } else {
      compositor = "BasicLayers (" + strings.GetStringFromName("mainThreadNoOMTC") + ")";
    }
    addRow("features", "compositing", compositor);
    delete data.windowLayerManagerRemote;
    delete data.windowLayerManagerType;
    delete data.numTotalWindows;
    delete data.numAcceleratedWindows;
    delete data.numAcceleratedWindowsMessage;
    delete data.windowUsingAdvancedLayers;

    addRow("features", "asyncPanZoom",
           apzInfo.length
           ? apzInfo.join("; ")
           : localizedMsg(["apzNone"]));
    addRowFromKey("features", "webgl1WSIInfo");
    addRowFromKey("features", "webgl1Renderer");
    addRowFromKey("features", "webgl1Version");
    addRowFromKey("features", "webgl1DriverExtensions");
    addRowFromKey("features", "webgl1Extensions");
    addRowFromKey("features", "webgl2WSIInfo");
    addRowFromKey("features", "webgl2Renderer");
    addRowFromKey("features", "webgl2Version");
    addRowFromKey("features", "webgl2DriverExtensions");
    addRowFromKey("features", "webgl2Extensions");
    addRowFromKey("features", "supportsHardwareH264", "hardwareH264");
    addRowFromKey("features", "direct2DEnabled", "#Direct2D");
    addRowFromKey("features", "usesTiling");
    addRowFromKey("features", "contentUsesTiling");
    addRowFromKey("features", "offMainThreadPaintEnabled");
    addRowFromKey("features", "offMainThreadPaintWorkerCount");

    if ("directWriteEnabled" in data) {
      let message = data.directWriteEnabled;
      if ("directWriteVersion" in data)
        message += " (" + data.directWriteVersion + ")";
      addRow("features", "#DirectWrite", message);
      delete data.directWriteEnabled;
      delete data.directWriteVersion;
    }

    // Adapter tbodies.
    let adapterKeys = [
      ["adapterDescription", "gpuDescription"],
      ["adapterVendorID", "gpuVendorID"],
      ["adapterDeviceID", "gpuDeviceID"],
      ["driverVersion", "gpuDriverVersion"],
      ["driverDate", "gpuDriverDate"],
      ["adapterDrivers", "gpuDrivers"],
      ["adapterSubsysID", "gpuSubsysID"],
      ["adapterRAM", "gpuRAM"],
    ];

    function showGpu(id, suffix) {
      function get(prop) {
        return data[prop + suffix];
      }

      let trs = [];
      for (let [prop, key] of adapterKeys) {
        let value = get(prop);
        if (value === undefined || value === "")
          continue;
        trs.push(buildRow(key, value));
      }

      if (trs.length == 0) {
        $("graphics-" + id + "-tbody").style.display = "none";
        return;
      }

      let active = "yes";
      if ("isGPU2Active" in data && ((suffix == "2") != data.isGPU2Active)) {
        active = "no";
      }
      addRow(id, "gpuActive", strings.GetStringFromName(active));
      addRows(id, trs);
    }
    showGpu("gpu-1", "");
    showGpu("gpu-2", "2");

    // Remove adapter keys.
    for (let [prop, /* key */] of adapterKeys) {
      delete data[prop];
      delete data[prop + "2"];
    }
    delete data.isGPU2Active;

    let featureLog = data.featureLog;
    delete data.featureLog;

    let features = [];
    for (let feature of featureLog.features) {
      // Only add interesting decisions - ones that were not automatic based on
      // all.js/gfxPrefs defaults.
      if (feature.log.length > 1 || feature.log[0].status != "available") {
        features.push(feature);
      }
    }

    if (features.length) {
      for (let feature of features) {
        let trs = [];
        for (let entry of feature.log) {
          if (entry.type == "default" && entry.status == "available")
            continue;

          let contents;
          if (entry.message.length > 0 && entry.message[0] == "#") {
            // This is a failure ID. See nsIGfxInfo.idl.
            let m = /#BLOCKLIST_FEATURE_FAILURE_BUG_(\d+)/.exec(entry.message);
            if (m) {
              let bugSpan = $.new("span");
              bugSpan.textContent = strings.GetStringFromName("blocklistedBug") + "; ";

              let bugHref = $.new("a");
              bugHref.href = "https://bugzilla.mozilla.org/show_bug.cgi?id=" + m[1];
              bugHref.textContent = strings.formatStringFromName("bugLink", [m[1]], 1);

              contents = [bugSpan, bugHref];
            } else {
              contents = strings.formatStringFromName(
                "unknownFailure", [entry.message.substr(1)], 1);
            }
          } else {
            contents = entry.status + " by " + entry.type + ": " + entry.message;
          }

          trs.push($.new("tr", [
            $.new("td", contents),
          ]));
        }
        addRow("decisions", feature.name, [$.new("table", trs)]);
      }
    } else {
      $("graphics-decisions-tbody").style.display = "none";
    }

    if (featureLog.fallbacks.length) {
      for (let fallback of featureLog.fallbacks) {
        addRow("workarounds", fallback.name, fallback.message);
      }
    } else {
      $("graphics-workarounds-tbody").style.display = "none";
    }

    let crashGuards = data.crashGuards;
    delete data.crashGuards;

    if (crashGuards.length) {
      for (let guard of crashGuards) {
        let resetButton = $.new("button");
        let onClickReset = function() {
          Services.prefs.setIntPref(guard.prefName, 0);
          resetButton.removeEventListener("click", onClickReset);
          resetButton.disabled = true;
        };

        resetButton.textContent = strings.GetStringFromName("resetOnNextRestart");
        resetButton.addEventListener("click", onClickReset);

        addRow("crashguards", guard.type + "CrashGuard", [resetButton]);
      }
    } else {
      $("graphics-crashguards-tbody").style.display = "none";
    }

    // Now that we're done, grab any remaining keys in data and drop them into
    // the diagnostics section.
    for (let key in data) {
      let value = data[key];
      if (Array.isArray(value)) {
        value = localizedMsg(value);
      }
      addRow("diagnostics", key, value);
    }
  },

  media: function media(data) {
    let strings = stringBundle();

    function insertBasicInfo(key, value) {
      function createRow(key, value) {
        let th = $.new("th", strings.GetStringFromName(key), "column");
        let td = $.new("td", value);
        td.style["white-space"] = "pre-wrap";
        td.colSpan = 8;
        return $.new("tr", [th, td]);
      }
      $.append($("media-info-tbody"), [createRow(key, value)]);
    }

    function createDeviceInfoRow(device) {
      let deviceInfo = Ci.nsIAudioDeviceInfo;

      let states = {};
      states[deviceInfo.STATE_DISABLED] = "Disabled";
      states[deviceInfo.STATE_UNPLUGGED] = "Unplugged";
      states[deviceInfo.STATE_ENABLED] = "Enabled";

      let preferreds = {};
      preferreds[deviceInfo.PREF_NONE] = "None";
      preferreds[deviceInfo.PREF_MULTIMEDIA] = "Multimedia";
      preferreds[deviceInfo.PREF_VOICE] = "Voice";
      preferreds[deviceInfo.PREF_NOTIFICATION] = "Notification";
      preferreds[deviceInfo.PREF_ALL] = "All";

      let formats = {};
      formats[deviceInfo.FMT_S16LE] = "S16LE";
      formats[deviceInfo.FMT_S16BE] = "S16BE";
      formats[deviceInfo.FMT_F32LE] = "F32LE";
      formats[deviceInfo.FMT_F32BE] = "F32BE";

      function toPreferredString(preferred) {
        if (preferred == deviceInfo.PREF_NONE) {
          return preferreds[deviceInfo.PREF_NONE];
        } else if (preferred & deviceInfo.PREF_ALL) {
          return preferreds[deviceInfo.PREF_ALL];
        }
        let str = "";
        for (let pref of [deviceInfo.PREF_MULTIMEDIA,
                          deviceInfo.PREF_VOICE,
                          deviceInfo.PREF_NOTIFICATION]) {
          if (preferred & pref) {
            str += " " + preferreds[pref];
          }
        }
        return str;
      }

      function toFromatString(dev) {
        let str = "default: " + formats[dev.defaultFormat] + ", support:";
        for (let fmt of [deviceInfo.FMT_S16LE,
                         deviceInfo.FMT_S16BE,
                         deviceInfo.FMT_F32LE,
                         deviceInfo.FMT_F32BE]) {
          if (dev.supportedFormat & fmt) {
            str += " " + formats[fmt];
          }
        }
        return str;
      }

      function toRateString(dev) {
        return "default: " + dev.defaultRate +
               ", support: " + dev.minRate + " - " + dev.maxRate;
      }

      function toLatencyString(dev) {
        return dev.minLatency + " - " + dev.maxLatency;
      }

      return $.new("tr", [$.new("td", device.name),
                          $.new("td", device.groupId),
                          $.new("td", device.vendor),
                          $.new("td", states[device.state]),
                          $.new("td", toPreferredString(device.preferred)),
                          $.new("td", toFromatString(device)),
                          $.new("td", device.maxChannels),
                          $.new("td", toRateString(device)),
                          $.new("td", toLatencyString(device))]);
    }

    function insertDeviceInfo(side, devices) {
      let rows = [];
      for (let dev of devices) {
        rows.push(createDeviceInfoRow(dev));
      }
      $.append($("media-" + side + "-devices-tbody"), rows);
    }

    // Basic information
    insertBasicInfo("audioBackend", data.currentAudioBackend);
    insertBasicInfo("maxAudioChannels", data.currentMaxAudioChannels);
    insertBasicInfo("sampleRate", data.currentPreferredSampleRate);

    // Output devices information
    insertDeviceInfo("output", data.audioOutputDevices);

    // Input devices information
    insertDeviceInfo("input", data.audioInputDevices);
  },

  javaScript: function javaScript(data) {
    $("javascript-incremental-gc").textContent = data.incrementalGCEnabled;
  },

  accessibility: function accessibility(data) {
    $("a11y-activated").textContent = data.isActive;
    $("a11y-force-disabled").textContent = data.forceDisabled || 0;

    let a11yHandlerUsed = $("a11y-handler-used");
    if (a11yHandlerUsed) {
      a11yHandlerUsed.textContent = data.handlerUsed;
    }

    let a11yInstantiator = $("a11y-instantiator");
    if (a11yInstantiator) {
      a11yInstantiator.textContent = data.instantiator;
    }
  },

  libraryVersions: function libraryVersions(data) {
    let strings = stringBundle();
    let trs = [
      $.new("tr", [
        $.new("th", ""),
        $.new("th", strings.GetStringFromName("minLibVersions")),
        $.new("th", strings.GetStringFromName("loadedLibVersions")),
      ])
    ];
    sortedArrayFromObject(data).forEach(
      function([name, val]) {
        trs.push($.new("tr", [
          $.new("td", name),
          $.new("td", val.minVersion),
          $.new("td", val.version),
        ]));
      }
    );
    $.append($("libversions-tbody"), trs);
  },

  userJS: function userJS(data) {
    if (!data.exists)
      return;
    let userJSFile = Services.dirsvc.get("PrefD", Ci.nsIFile);
    userJSFile.append("user.js");
    $("prefs-user-js-link").href = Services.io.newFileURI(userJSFile).spec;
    $("prefs-user-js-section").style.display = "";
    // Clear the no-copy class
    $("prefs-user-js-section").className = "";
  },

  sandbox: function sandbox(data) {
    if (!AppConstants.MOZ_SANDBOX)
      return;

    let strings = stringBundle();
    let tbody = $("sandbox-tbody");
    for (let key in data) {
      // Simplify the display a little in the common case.
      if (key === "hasPrivilegedUserNamespaces" &&
          data[key] === data.hasUserNamespaces) {
        continue;
      }
      if (key === "syscallLog") {
        // Not in this table.
        continue;
      }
      tbody.appendChild($.new("tr", [
        $.new("th", strings.GetStringFromName(key), "column"),
        $.new("td", data[key]),
      ]));
    }

    if ("syscallLog" in data) {
      let syscallBody = $("sandbox-syscalls-tbody");
      let argsHead = $("sandbox-syscalls-argshead");
      for (let syscall of data.syscallLog) {
        if (argsHead.colSpan < syscall.args.length) {
          argsHead.colSpan = syscall.args.length;
        }
        let cells = [
          $.new("td", syscall.index, "integer"),
          $.new("td", syscall.msecAgo / 1000),
          $.new("td", syscall.pid, "integer"),
          $.new("td", syscall.tid, "integer"),
          $.new("td", strings.GetStringFromName("sandboxProcType." +
                                                syscall.procType)),
          $.new("td", syscall.syscall, "integer"),
        ];
        for (let arg of syscall.args) {
          cells.push($.new("td", arg, "integer"));
        }
        syscallBody.appendChild($.new("tr", cells));
      }
    }
  },

  intl: function intl(data) {
    $("intl-locale-requested").textContent =
      JSON.stringify(data.localeService.requested);
    $("intl-locale-available").textContent =
      JSON.stringify(data.localeService.available);
    $("intl-locale-supported").textContent =
      JSON.stringify(data.localeService.supported);
    $("intl-locale-regionalprefs").textContent =
      JSON.stringify(data.localeService.regionalPrefs);
    $("intl-locale-default").textContent =
      JSON.stringify(data.localeService.defaultLocale);

    $("intl-osprefs-systemlocales").textContent =
      JSON.stringify(data.osPrefs.systemLocales);
    $("intl-osprefs-regionalprefs").textContent =
      JSON.stringify(data.osPrefs.regionalPrefsLocales);
  }
};

var $ = document.getElementById.bind(document);

$.new = function $_new(tag, textContentOrChildren, className, attributes) {
  let elt = document.createElement(tag);
  if (className)
    elt.className = className;
  if (attributes) {
    for (let attrName in attributes)
      elt.setAttribute(attrName, attributes[attrName]);
  }
  if (Array.isArray(textContentOrChildren))
    this.append(elt, textContentOrChildren);
  else
    elt.textContent = String(textContentOrChildren);
  return elt;
};

$.append = function $_append(parent, children) {
  children.forEach(c => parent.appendChild(c));
};

function stringBundle() {
  return Services.strings.createBundle(
           "chrome://global/locale/aboutSupport.properties");
}

function assembleFromGraphicsFailure(i, data) {
  // Only cover the cases we have today; for example, we do not have
  // log failures that assert and we assume the log level is 1/error.
  let message = data.failures[i];
  let index = data.indices[i];
  let what = "";
  if (message.search(/\[GFX1-\]: \(LF\)/) == 0) {
    // Non-asserting log failure - the message is substring(14)
    what = "LogFailure";
    message = message.substring(14);
  } else if (message.search(/\[GFX1-\]: /) == 0) {
    // Non-asserting - the message is substring(9)
    what = "Error";
    message = message.substring(9);
  } else if (message.search(/\[GFX1\]: /) == 0) {
    // Asserting - the message is substring(8)
    what = "Assert";
    message = message.substring(8);
  }
  let assembled = {"index": index,
                   "header": ("(#" + index + ") " + what),
                   "message": message};
  return assembled;
}

function sortedArrayFromObject(obj) {
  let tuples = [];
  for (let prop in obj)
    tuples.push([prop, obj[prop]]);
  tuples.sort(([prop1, v1], [prop2, v2]) => prop1.localeCompare(prop2));
  return tuples;
}

function copyRawDataToClipboard(button) {
  if (button)
    button.disabled = true;
  try {
    Troubleshoot.snapshot(function(snapshot) {
      if (button)
        button.disabled = false;
      let str = Cc["@mozilla.org/supports-string;1"].
                createInstance(Ci.nsISupportsString);
      str.data = JSON.stringify(snapshot, undefined, 2);
      let transferable = Cc["@mozilla.org/widget/transferable;1"].
                         createInstance(Ci.nsITransferable);
      transferable.init(getLoadContext());
      transferable.addDataFlavor("text/unicode");
      transferable.setTransferData("text/unicode", str, str.data.length * 2);
      Services.clipboard.setData(transferable, null, Ci.nsIClipboard.kGlobalClipboard);
      if (AppConstants.platform == "android") {
        // Present a snackbar notification.
        ChromeUtils.import("resource://gre/modules/Snackbars.jsm");
        Snackbars.show(stringBundle().GetStringFromName("rawDataCopied"),
                       Snackbars.LENGTH_SHORT);
      }
    });
  } catch (err) {
    if (button)
      button.disabled = false;
    throw err;
  }
}

function getLoadContext() {
  return window.docShell.QueryInterface(Ci.nsILoadContext);
}

function copyContentsToClipboard() {
  // Get the HTML and text representations for the important part of the page.
  let contentsDiv = $("contents");
  let dataHtml = contentsDiv.innerHTML;
  let dataText = createTextForElement(contentsDiv);

  // We can't use plain strings, we have to use nsSupportsString.
  let supportsStringClass = Cc["@mozilla.org/supports-string;1"];
  let ssHtml = supportsStringClass.createInstance(Ci.nsISupportsString);
  let ssText = supportsStringClass.createInstance(Ci.nsISupportsString);

  let transferable = Cc["@mozilla.org/widget/transferable;1"]
                       .createInstance(Ci.nsITransferable);
  transferable.init(getLoadContext());

  // Add the HTML flavor.
  transferable.addDataFlavor("text/html");
  ssHtml.data = dataHtml;
  transferable.setTransferData("text/html", ssHtml, dataHtml.length * 2);

  // Add the plain text flavor.
  transferable.addDataFlavor("text/unicode");
  ssText.data = dataText;
  transferable.setTransferData("text/unicode", ssText, dataText.length * 2);

  // Store the data into the clipboard.
  Services.clipboard.setData(transferable, null, Services.clipboard.kGlobalClipboard);

  if (AppConstants.platform == "android") {
    // Present a snackbar notification.
    ChromeUtils.import("resource://gre/modules/Snackbars.jsm");
    Snackbars.show(stringBundle().GetStringFromName("textCopied"),
                   Snackbars.LENGTH_SHORT);
  }
}

// Return the plain text representation of an element.  Do a little bit
// of pretty-printing to make it human-readable.
function createTextForElement(elem) {
  let serializer = new Serializer();
  let text = serializer.serialize(elem);

  // Actual CR/LF pairs are needed for some Windows text editors.
  if (AppConstants.platform == "win") {
    text = text.replace(/\n/g, "\r\n");
  }

  return text;
}

function Serializer() {
}

Serializer.prototype = {

  serialize(rootElem) {
    this._lines = [];
    this._startNewLine();
    this._serializeElement(rootElem);
    this._startNewLine();
    return this._lines.join("\n").trim() + "\n";
  },

  // The current line is always the line that writing will start at next.  When
  // an element is serialized, the current line is updated to be the line at
  // which the next element should be written.
  get _currentLine() {
    return this._lines.length ? this._lines[this._lines.length - 1] : null;
  },

  set _currentLine(val) {
    return this._lines[this._lines.length - 1] = val;
  },

  _serializeElement(elem) {
    if (this._ignoreElement(elem))
      return;

    // table
    if (elem.localName == "table") {
      this._serializeTable(elem);
      return;
    }

    // all other elements

    let hasText = false;
    for (let child of elem.childNodes) {
      if (child.nodeType == Node.TEXT_NODE) {
        let text = this._nodeText(child);
        this._appendText(text);
        hasText = hasText || !!text.trim();
      } else if (child.nodeType == Node.ELEMENT_NODE)
        this._serializeElement(child);
    }

    // For headings, draw a "line" underneath them so they stand out.
    if (/^h[0-9]+$/.test(elem.localName)) {
      let headerText = (this._currentLine || "").trim();
      if (headerText) {
        this._startNewLine();
        this._appendText("-".repeat(headerText.length));
      }
    }

    // Add a blank line underneath block elements but only if they contain text.
    if (hasText) {
      let display = window.getComputedStyle(elem).getPropertyValue("display");
      if (display == "block") {
        this._startNewLine();
        this._startNewLine();
      }
    }
  },

  _startNewLine(lines) {
    let currLine = this._currentLine;
    if (currLine) {
      // The current line is not empty.  Trim it.
      this._currentLine = currLine.trim();
      if (!this._currentLine)
        // The current line became empty.  Discard it.
        this._lines.pop();
    }
    this._lines.push("");
  },

  _appendText(text, lines) {
    this._currentLine += text;
  },

  _isHiddenSubHeading(th) {
    return th.parentNode.parentNode.style.display == "none";
  },

  _serializeTable(table) {
    // Collect the table's column headings if in fact there are any.  First
    // check thead.  If there's no thead, check the first tr.
    let colHeadings = {};
    let tableHeadingElem = table.querySelector("thead");
    if (!tableHeadingElem)
      tableHeadingElem = table.querySelector("tr");
    if (tableHeadingElem) {
      let tableHeadingCols = tableHeadingElem.querySelectorAll("th,td");
      // If there's a contiguous run of th's in the children starting from the
      // rightmost child, then consider them to be column headings.
      for (let i = tableHeadingCols.length - 1; i >= 0; i--) {
        let col = tableHeadingCols[i];
        if (col.localName != "th" || col.classList.contains("title-column"))
          break;
        colHeadings[i] = this._nodeText(col).trim();
      }
    }
    let hasColHeadings = Object.keys(colHeadings).length > 0;
    if (!hasColHeadings)
      tableHeadingElem = null;

    let trs = table.querySelectorAll("table > tr, tbody > tr");
    let startRow =
      tableHeadingElem && tableHeadingElem.localName == "tr" ? 1 : 0;

    if (startRow >= trs.length)
      // The table's empty.
      return;

    if (hasColHeadings && !this._ignoreElement(tableHeadingElem)) {
      // Use column headings.  Print each tr as a multi-line chunk like:
      //   Heading 1: Column 1 value
      //   Heading 2: Column 2 value
      for (let i = startRow; i < trs.length; i++) {
        if (this._ignoreElement(trs[i]))
          continue;
        let children = trs[i].querySelectorAll("td");
        for (let j = 0; j < children.length; j++) {
          let text = "";
          if (colHeadings[j])
            text += colHeadings[j] + ": ";
          text += this._nodeText(children[j]).trim();
          this._appendText(text);
          this._startNewLine();
        }
        this._startNewLine();
      }
      return;
    }

    // Don't use column headings.  Assume the table has only two columns and
    // print each tr in a single line like:
    //   Column 1 value: Column 2 value
    for (let i = startRow; i < trs.length; i++) {
      if (this._ignoreElement(trs[i]))
        continue;
      let children = trs[i].querySelectorAll("th,td");
      let rowHeading = this._nodeText(children[0]).trim();
      if (children[0].classList.contains("title-column")) {
        if (!this._isHiddenSubHeading(children[0]))
          this._appendText(rowHeading);
      } else if (children.length == 1) {
        // This is a single-cell row.
        this._appendText(rowHeading);
      } else {
        let childTables = trs[i].querySelectorAll("table");
        if (childTables.length) {
          // If we have child tables, don't use nodeText - its trs are already
          // queued up from querySelectorAll earlier.
          this._appendText(rowHeading + ": ");
        } else {
          this._appendText(rowHeading + ": " + this._nodeText(children[1]).trim());
        }
      }
      this._startNewLine();
    }
    this._startNewLine();
  },

  _ignoreElement(elem) {
    return elem.classList.contains("no-copy");
  },

  _nodeText(node) {
    return node.textContent.replace(/\s+/g, " ");
  },
};

function openProfileDirectory() {
  // Get the profile directory.
  let currProfD = Services.dirsvc.get("ProfD", Ci.nsIFile);
  let profileDir = currProfD.path;

  // Show the profile directory.
  let nsLocalFile = Components.Constructor("@mozilla.org/file/local;1",
                                           "nsIFile", "initWithPath");
  new nsLocalFile(profileDir).reveal();
}

/**
 * Profile reset is only supported for the default profile if the appropriate migrator exists.
 */
function populateActionBox() {
  if (ResetProfile.resetSupported()) {
    $("reset-box").style.display = "block";
    $("action-box").style.display = "block";
  }
  if (!Services.appinfo.inSafeMode && AppConstants.platform !== "android") {
    $("safe-mode-box").style.display = "block";
    $("action-box").style.display = "block";

    if (Services.policies && !Services.policies.isAllowed("safeMode")) {
      $("restart-in-safe-mode-button").setAttribute("disabled", "true");
    }
  }
}

// Prompt user to restart the browser in safe mode
function safeModeRestart() {
  let cancelQuit = Cc["@mozilla.org/supports-PRBool;1"]
                     .createInstance(Ci.nsISupportsPRBool);
  Services.obs.notifyObservers(cancelQuit, "quit-application-requested", "restart");

  if (!cancelQuit.data) {
    Services.startup.restartInSafeMode(Ci.nsIAppStartup.eAttemptQuit);
  }
}
/**
 * Set up event listeners for buttons.
 */
function setupEventListeners() {
  if (AppConstants.platform !== "android") {
    $("show-update-history-button").addEventListener("click", function(event) {
      var prompter = Cc["@mozilla.org/updates/update-prompt;1"].createInstance(Ci.nsIUpdatePrompt);
      prompter.showUpdateHistory(window);
    });
    $("reset-box-button").addEventListener("click", function(event) {
      ResetProfile.openConfirmationDialog(window);
    });
    $("restart-in-safe-mode-button").addEventListener("click", function(event) {
      if (Services.obs.enumerateObservers("restart-in-safe-mode").hasMoreElements()) {
        Services.obs.notifyObservers(null, "restart-in-safe-mode");
      } else {
        safeModeRestart();
      }
    });
    $("verify-place-integrity-button").addEventListener("click", function(event) {
      PlacesDBUtils.checkAndFixDatabase().then((tasksStatusMap) => {
        let logs = [];
        for (let [key, value] of tasksStatusMap) {
          logs.push(`> Task: ${key}`);
          let prefix = value.succeeded ? "+ " : "- ";
          logs = logs.concat(value.logs.map(m => `${prefix}${m}`));
        }
        $("verify-place-result").style.display = "block";
        $("verify-place-result").classList.remove("no-copy");
        $("verify-place-result").textContent = logs.join("\n");
      });
    });
  }

  $("copy-raw-data-to-clipboard").addEventListener("click", function(event) {
    copyRawDataToClipboard(this);
  });
  $("copy-to-clipboard").addEventListener("click", function(event) {
    copyContentsToClipboard();
  });
  $("profile-dir-button").addEventListener("click", function(event) {
    openProfileDirectory();
  });
}
