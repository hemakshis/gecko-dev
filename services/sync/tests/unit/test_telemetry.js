/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

ChromeUtils.import("resource://services-common/observers.js");
ChromeUtils.import("resource://services-common/utils.js");
ChromeUtils.import("resource://services-sync/telemetry.js");
ChromeUtils.import("resource://services-sync/service.js");
ChromeUtils.import("resource://services-sync/record.js");
ChromeUtils.import("resource://services-sync/resource.js");
ChromeUtils.import("resource://services-sync/constants.js");
ChromeUtils.import("resource://services-sync/engines.js");
ChromeUtils.import("resource://services-sync/engines/bookmarks.js");
ChromeUtils.import("resource://services-sync/engines/clients.js");
ChromeUtils.import("resource://testing-common/services/sync/fxa_utils.js");
ChromeUtils.import("resource://testing-common/services/sync/rotaryengine.js");
ChromeUtils.import("resource://gre/modules/osfile.jsm", this);

ChromeUtils.import("resource://services-sync/util.js");


function SteamStore(engine) {
  Store.call(this, "Steam", engine);
}

SteamStore.prototype = {
  __proto__: Store.prototype,
};

function SteamTracker(name, engine) {
  Tracker.call(this, name || "Steam", engine);
}

SteamTracker.prototype = {
  __proto__: Tracker.prototype,
  persistChangedIDs: false,
};

function SteamEngine(service) {
  SyncEngine.call(this, "steam", service);
}

SteamEngine.prototype = {
  __proto__: SyncEngine.prototype,
  _storeObj: SteamStore,
  _trackerObj: SteamTracker,
  _errToThrow: null,
  async _sync() {
    if (this._errToThrow) {
      throw this._errToThrow;
    }
  }
};

function BogusEngine(service) {
  SyncEngine.call(this, "bogus", service);
}

BogusEngine.prototype = Object.create(SteamEngine.prototype);

async function cleanAndGo(engine, server) {
  await engine._tracker.clearChangedIDs();
  Svc.Prefs.resetBranch("");
  syncTestLogging();
  Service.recordManager.clearCache();
  await promiseStopServer(server);
}

add_task(async function setup() {
  // Avoid addon manager complaining about not being initialized
  await Service.engineManager.unregister("addons");
});

add_task(async function test_basic() {
  enableValidationPrefs();

  let helper = track_collections_helper();
  let upd = helper.with_updated_collection;

  let handlers = {
    "/1.1/johndoe/info/collections": helper.handler,
    "/1.1/johndoe/storage/crypto/keys": upd("crypto", new ServerWBO("keys").handler()),
    "/1.1/johndoe/storage/meta/global": upd("meta", new ServerWBO("global").handler())
  };

  let collections = ["clients", "bookmarks", "forms", "history", "passwords", "prefs", "tabs"];

  for (let coll of collections) {
    handlers["/1.1/johndoe/storage/" + coll] = upd(coll, new ServerCollection({}, true).handler());
  }

  let server = httpd_setup(handlers);
  await configureIdentity({ username: "johndoe" }, server);

  let ping = await sync_and_validate_telem(true, true);

  // Check the "os" block - we can't really check specific values, but can
  // check it smells sane.
  ok(ping.os, "there is an OS block");
  ok("name" in ping.os, "there is an OS name");
  ok("version" in ping.os, "there is an OS version");
  ok("locale" in ping.os, "there is an OS locale");

  Svc.Prefs.resetBranch("");
  await promiseStopServer(server);
});

add_task(async function test_processIncoming_error() {
  let engine = new BookmarksEngine(Service);
  await engine.initialize();
  let store  = engine._store;
  let server = await serverForFoo(engine);
  await SyncTestingInfrastructure(server);
  let collection = server.user("foo").collection("bookmarks");
  try {
    // Create a bogus record that when synced down will provoke a
    // network error which in turn provokes an exception in _processIncoming.
    const BOGUS_GUID = "zzzzzzzzzzzz";
    let bogus_record = collection.insert(BOGUS_GUID, "I'm a bogus record!");
    bogus_record.get = function get() {
      throw new Error("Sync this!");
    };
    // Make the 10 minutes old so it will only be synced in the toFetch phase.
    bogus_record.modified = Date.now() / 1000 - 60 * 10;
    await engine.setLastSync(Date.now() / 1000 - 60);
    engine.toFetch = new SerializableSet([BOGUS_GUID]);

    let error, pingPayload, fullPing;
    try {
      await sync_engine_and_validate_telem(engine, true, (errPing, fullErrPing) => {
        pingPayload = errPing;
        fullPing = fullErrPing;
      });
    } catch (ex) {
      error = ex;
    }
    ok(!!error);
    ok(!!pingPayload);

    equal(fullPing.uid, "f".repeat(32)); // as setup by SyncTestingInfrastructure
    deepEqual(pingPayload.failureReason, {
      name: "httperror",
      code: 500,
    });

    equal(pingPayload.engines.length, 1);
    equal(pingPayload.engines[0].name, "bookmarks");
    deepEqual(pingPayload.engines[0].failureReason, {
      name: "httperror",
      code: 500,
    });

  } finally {
    await store.wipe();
    await cleanAndGo(engine, server);
  }
});

add_task(async function test_uploading() {
  let engine = new BookmarksEngine(Service);
  await engine.initialize();
  let store  = engine._store;
  let server = await serverForFoo(engine);
  await SyncTestingInfrastructure(server);

  let bmk = await PlacesUtils.bookmarks.insert({
    parentGuid: PlacesUtils.bookmarks.toolbarGuid,
    url: "http://getfirefox.com/",
    title: "Get Firefox!",
  });

  try {
    let ping = await sync_engine_and_validate_telem(engine, false);
    ok(!!ping);
    equal(ping.engines.length, 1);
    equal(ping.engines[0].name, "bookmarks");
    ok(!!ping.engines[0].outgoing);
    greater(ping.engines[0].outgoing[0].sent, 0);
    ok(!ping.engines[0].incoming);

    await PlacesUtils.bookmarks.update({
      guid: bmk.guid,
      title: "New Title",
    });

    await store.wipe();
    await engine.resetClient();

    ping = await sync_engine_and_validate_telem(engine, false);
    equal(ping.engines.length, 1);
    equal(ping.engines[0].name, "bookmarks");
    equal(ping.engines[0].outgoing.length, 1);
    ok(!!ping.engines[0].incoming);

  } finally {
    // Clean up.
    await store.wipe();
    await cleanAndGo(engine, server);
  }
});

add_task(async function test_upload_failed() {
  let collection = new ServerCollection();
  collection._wbos.flying = new ServerWBO("flying");

  let server = sync_httpd_setup({
      "/1.1/foo/storage/rotary": collection.handler()
  });

  await SyncTestingInfrastructure(server);
  await configureIdentity({ username: "foo" }, server);

  let engine = new RotaryEngine(Service);
  engine._store.items = {
    flying: "LNER Class A3 4472",
    scotsman: "Flying Scotsman",
    peppercorn: "Peppercorn Class"
  };
  const FLYING_CHANGED = 12345;
  const SCOTSMAN_CHANGED = 23456;
  const PEPPERCORN_CHANGED = 34567;
  await engine._tracker.addChangedID("flying", FLYING_CHANGED);
  await engine._tracker.addChangedID("scotsman", SCOTSMAN_CHANGED);
  await engine._tracker.addChangedID("peppercorn", PEPPERCORN_CHANGED);

  let syncID = await engine.resetLocalSyncID();
  let meta_global = Service.recordManager.set(engine.metaURL, new WBORecord(engine.metaURL));
  meta_global.payload.engines = { rotary: { version: engine.version, syncID } };

  try {
    await engine.setLastSync(123); // needs to be non-zero so that tracker is queried
    let changes = await engine._tracker.getChangedIDs();
    _(`test_upload_failed: Rotary tracker contents at first sync: ${
      JSON.stringify(changes)}`);
    engine.enabled = true;
    let ping = await sync_engine_and_validate_telem(engine, true);
    ok(!!ping);
    equal(ping.engines.length, 1);
    equal(ping.engines[0].incoming, null);
    deepEqual(ping.engines[0].outgoing, [{ sent: 3, failed: 2 }]);
    await engine.setLastSync(123);

    changes = await engine._tracker.getChangedIDs();
    _(`test_upload_failed: Rotary tracker contents at second sync: ${
      JSON.stringify(changes)}`);
    ping = await sync_engine_and_validate_telem(engine, true);
    ok(!!ping);
    equal(ping.engines.length, 1);
    equal(ping.engines[0].incoming.reconciled, 1);
    deepEqual(ping.engines[0].outgoing, [{ sent: 2, failed: 2 }]);

  } finally {
    await cleanAndGo(engine, server);
    await engine.finalize();
  }
});

add_task(async function test_sync_partialUpload() {
  let collection = new ServerCollection();
  let server = sync_httpd_setup({
      "/1.1/foo/storage/rotary": collection.handler()
  });
  await SyncTestingInfrastructure(server);
  await generateNewKeys(Service.collectionKeys);

  let engine = new RotaryEngine(Service);
  await engine.setLastSync(123);

  // Create a bunch of records (and server side handlers)
  for (let i = 0; i < 234; i++) {
    let id = "record-no-" + i;
    engine._store.items[id] = "Record No. " + i;
    await engine._tracker.addChangedID(id, i);
    // Let two items in the first upload batch fail.
    if (i != 23 && i != 42) {
      collection.insert(id);
    }
  }

  let syncID = await engine.resetLocalSyncID();
  let meta_global = Service.recordManager.set(engine.metaURL,
                                              new WBORecord(engine.metaURL));
  meta_global.payload.engines = {rotary: {version: engine.version, syncID}};

  try {
    let changes = await engine._tracker.getChangedIDs();
    _(`test_sync_partialUpload: Rotary tracker contents at first sync: ${
      JSON.stringify(changes)}`);
    engine.enabled = true;
    let ping = await sync_engine_and_validate_telem(engine, true);

    ok(!!ping);
    ok(!ping.failureReason);
    equal(ping.engines.length, 1);
    equal(ping.engines[0].name, "rotary");
    ok(!ping.engines[0].incoming);
    ok(!ping.engines[0].failureReason);
    deepEqual(ping.engines[0].outgoing, [{ sent: 234, failed: 2 }]);

    collection.post = function() { throw new Error("Failure"); };

    engine._store.items["record-no-1000"] = "Record No. 1000";
    await engine._tracker.addChangedID("record-no-1000", 1000);
    collection.insert("record-no-1000", 1000);

    await engine.setLastSync(123);
    ping = null;

    changes = await engine._tracker.getChangedIDs();
    _(`test_sync_partialUpload: Rotary tracker contents at second sync: ${
      JSON.stringify(changes)}`);
    try {
      // should throw
      await sync_engine_and_validate_telem(engine, true, errPing => ping = errPing);
    } catch (e) {}
    // It would be nice if we had a more descriptive error for this...
    let uploadFailureError = {
      name: "httperror",
      code: 500,
    };

    ok(!!ping);
    deepEqual(ping.failureReason, uploadFailureError);
    equal(ping.engines.length, 1);
    equal(ping.engines[0].name, "rotary");
    deepEqual(ping.engines[0].incoming, {
      failed: 1,
      newFailed: 1,
      reconciled: 232
    });
    ok(!ping.engines[0].outgoing);
    deepEqual(ping.engines[0].failureReason, uploadFailureError);

  } finally {
    await cleanAndGo(engine, server);
    await engine.finalize();
  }
});

add_task(async function test_generic_engine_fail() {
  enableValidationPrefs();

  await Service.engineManager.register(SteamEngine);
  let engine = Service.engineManager.get("steam");
  engine.enabled = true;
  let server = await serverForFoo(engine);
  await SyncTestingInfrastructure(server);
  let e = new Error("generic failure message");
  engine._errToThrow = e;

  try {
    const changes = await engine._tracker.getChangedIDs();
    _(`test_generic_engine_fail: Steam tracker contents: ${
      JSON.stringify(changes)}`);
    let ping = await sync_and_validate_telem(true);
    equal(ping.status.service, SYNC_FAILED_PARTIAL);
    deepEqual(ping.engines.find(err => err.name === "steam").failureReason, {
      name: "unexpectederror",
      error: String(e)
    });
  } finally {
    await cleanAndGo(engine, server);
    await Service.engineManager.unregister(engine);
  }
});

add_task(async function test_engine_fail_weird_errors() {
  enableValidationPrefs();
  await Service.engineManager.register(SteamEngine);
  let engine = Service.engineManager.get("steam");
  engine.enabled = true;
  let server = await serverForFoo(engine);
  await SyncTestingInfrastructure(server);
  try {
    let msg = "Bad things happened!";
    engine._errToThrow = { message: msg };
    let ping = await sync_and_validate_telem(true);
    equal(ping.status.service, SYNC_FAILED_PARTIAL);
    deepEqual(ping.engines.find(err => err.name === "steam").failureReason, {
      name: "unexpectederror",
      error: "Bad things happened!"
    });
    let e = { msg };
    engine._errToThrow = e;
    ping = await sync_and_validate_telem(true);
    deepEqual(ping.engines.find(err => err.name === "steam").failureReason, {
      name: "unexpectederror",
      error: JSON.stringify(e)
    });
  } finally {
    await cleanAndGo(engine, server);
    Service.engineManager.unregister(engine);
  }
});


add_task(async function test_overrideTelemetryName() {
  enableValidationPrefs();

  await Service.engineManager.register(SteamEngine);
  let engine = Service.engineManager.get("steam");
  engine.overrideTelemetryName = "steam-but-better";
  engine.enabled = true;
  let server = await serverForFoo(engine);
  await SyncTestingInfrastructure(server);

  try {
    let ping = await sync_and_validate_telem(true);
    ok(ping.engines.find(e => e.name === "steam-but-better"));
    ok(!ping.engines.find(e => e.name === "steam"));
  } finally {
    await cleanAndGo(engine, server);
    await Service.engineManager.unregister(engine);
  }
});

add_task(async function test_engine_fail_ioerror() {
  enableValidationPrefs();

  await Service.engineManager.register(SteamEngine);
  let engine = Service.engineManager.get("steam");
  engine.enabled = true;
  let server = await serverForFoo(engine);
  await SyncTestingInfrastructure(server);
  // create an IOError to re-throw as part of Sync.
  try {
    // (Note that fakeservices.js has replaced Utils.jsonMove etc, but for
    // this test we need the real one so we get real exceptions from the
    // filesystem.)
    await Utils._real_jsonMove("file-does-not-exist", "anything", {});
  } catch (ex) {
    engine._errToThrow = ex;
  }
  ok(engine._errToThrow, "expecting exception");

  try {
    const changes = await engine._tracker.getChangedIDs();
    _(`test_engine_fail_ioerror: Steam tracker contents: ${
      JSON.stringify(changes)}`);
    let ping = await sync_and_validate_telem(true);
    equal(ping.status.service, SYNC_FAILED_PARTIAL);
    let failureReason = ping.engines.find(e => e.name === "steam").failureReason;
    equal(failureReason.name, "unexpectederror");
    // ensure the profile dir in the exception message has been stripped.
    ok(!failureReason.error.includes(OS.Constants.Path.profileDir), failureReason.error);
    ok(failureReason.error.includes("[profileDir]"), failureReason.error);
  } finally {
    await cleanAndGo(engine, server);
    await Service.engineManager.unregister(engine);
  }
});

add_task(async function test_clean_urls() {
  enableValidationPrefs();

  await Service.engineManager.register(SteamEngine);
  let engine = Service.engineManager.get("steam");
  engine.enabled = true;
  let server = await serverForFoo(engine);
  await SyncTestingInfrastructure(server);
  engine._errToThrow = new TypeError("http://www.google .com is not a valid URL.");

  try {
    const changes = await engine._tracker.getChangedIDs();
    _(`test_clean_urls: Steam tracker contents: ${
      JSON.stringify(changes)}`);
    let ping = await sync_and_validate_telem(true);
    equal(ping.status.service, SYNC_FAILED_PARTIAL);
    let failureReason = ping.engines.find(e => e.name === "steam").failureReason;
    equal(failureReason.name, "unexpectederror");
    equal(failureReason.error, "<URL> is not a valid URL.");
    // Handle other errors that include urls.
    engine._errToThrow = "Other error message that includes some:url/foo/bar/ in it.";
    ping = await sync_and_validate_telem(true);
    equal(ping.status.service, SYNC_FAILED_PARTIAL);
    failureReason = ping.engines.find(e => e.name === "steam").failureReason;
    equal(failureReason.name, "unexpectederror");
    equal(failureReason.error, "Other error message that includes <URL> in it.");
  } finally {
    await cleanAndGo(engine, server);
    await Service.engineManager.unregister(engine);
  }
});


add_task(async function test_initial_sync_engines() {
  enableValidationPrefs();

  await Service.engineManager.register(SteamEngine);
  let engine = Service.engineManager.get("steam");
  engine.enabled = true;
  // These are the only ones who actually have things to sync at startup.
  let engineNames = ["clients", "bookmarks", "prefs", "tabs"];
  let server = await serverForEnginesWithKeys({"foo": "password"}, ["bookmarks", "prefs", "tabs"].map(name =>
    Service.engineManager.get(name)
  ));
  await SyncTestingInfrastructure(server);
  try {
    const changes = await engine._tracker.getChangedIDs();
    _(`test_initial_sync_engines: Steam tracker contents: ${
      JSON.stringify(changes)}`);
    let ping = await wait_for_ping(() => Service.sync(), true);

    equal(ping.engines.find(e => e.name === "clients").outgoing[0].sent, 1);
    equal(ping.engines.find(e => e.name === "tabs").outgoing[0].sent, 1);

    // for the rest we don't care about specifics
    for (let e of ping.engines) {
      if (!engineNames.includes(engine.name)) {
        continue;
      }
      greaterOrEqual(e.took, 1);
      ok(!!e.outgoing);
      equal(e.outgoing.length, 1);
      notEqual(e.outgoing[0].sent, undefined);
      equal(e.outgoing[0].failed, undefined);
    }
  } finally {
    await cleanAndGo(engine, server);
    await Service.engineManager.unregister(engine);
  }
});

add_task(async function test_nserror() {
  enableValidationPrefs();

  await Service.engineManager.register(SteamEngine);
  let engine = Service.engineManager.get("steam");
  engine.enabled = true;
  let server = await serverForFoo(engine);
  await SyncTestingInfrastructure(server);
  engine._errToThrow = Components.Exception("NS_ERROR_UNKNOWN_HOST", Cr.NS_ERROR_UNKNOWN_HOST);
  try {
    const changes = await engine._tracker.getChangedIDs();
    _(`test_nserror: Steam tracker contents: ${
      JSON.stringify(changes)}`);
    let ping = await sync_and_validate_telem(true);
    deepEqual(ping.status, {
      service: SYNC_FAILED_PARTIAL,
      sync: LOGIN_FAILED_NETWORK_ERROR
    });
    let enginePing = ping.engines.find(e => e.name === "steam");
    deepEqual(enginePing.failureReason, {
      name: "nserror",
      code: Cr.NS_ERROR_UNKNOWN_HOST
    });
  } finally {
    await cleanAndGo(engine, server);
    await Service.engineManager.unregister(engine);
  }
});

add_task(async function test_sync_why() {
  enableValidationPrefs();

  await Service.engineManager.register(SteamEngine);
  let engine = Service.engineManager.get("steam");
  engine.enabled = true;
  let server = await serverForFoo(engine);
  await SyncTestingInfrastructure(server);
  let e = new Error("generic failure message");
  engine._errToThrow = e;

  try {
    const changes = await engine._tracker.getChangedIDs();
    _(`test_generic_engine_fail: Steam tracker contents: ${
      JSON.stringify(changes)}`);
    let ping = await wait_for_ping(() => Service.sync({why: "user"}), true, false);
    _(JSON.stringify(ping));
    equal(ping.why, "user");
  } finally {
    await cleanAndGo(engine, server);
    await Service.engineManager.unregister(engine);
  }
});

add_task(async function test_discarding() {
  enableValidationPrefs();

  let helper = track_collections_helper();
  let upd = helper.with_updated_collection;
  let telem = get_sync_test_telemetry();
  telem.maxPayloadCount = 2;
  telem.submissionInterval = Infinity;
  let oldSubmit = telem.submit;

  let server;
  try {

    let handlers = {
      "/1.1/johndoe/info/collections": helper.handler,
      "/1.1/johndoe/storage/crypto/keys": upd("crypto", new ServerWBO("keys").handler()),
      "/1.1/johndoe/storage/meta/global": upd("meta", new ServerWBO("global").handler())
    };

    let collections = ["clients", "bookmarks", "forms", "history", "passwords", "prefs", "tabs"];

    for (let coll of collections) {
      handlers["/1.1/johndoe/storage/" + coll] = upd(coll, new ServerCollection({}, true).handler());
    }

    server = httpd_setup(handlers);
    await configureIdentity({ username: "johndoe" }, server);
    telem.submit = () => ok(false, "Submitted telemetry ping when we should not have");

    for (let i = 0; i < 5; ++i) {
      await Service.sync();
    }
    telem.submit = oldSubmit;
    telem.submissionInterval = -1;
    let ping = await sync_and_validate_telem(true, true); // with this we've synced 6 times
    equal(ping.syncs.length, 2);
    equal(ping.discarded, 4);
  } finally {
    telem.maxPayloadCount = 500;
    telem.submissionInterval = -1;
    telem.submit = oldSubmit;
    if (server) {
      await promiseStopServer(server);
    }
  }
});

add_task(async function test_no_foreign_engines_in_error_ping() {
  enableValidationPrefs();

  await Service.engineManager.register(BogusEngine);
  let engine = Service.engineManager.get("bogus");
  engine.enabled = true;
  let server = await serverForFoo(engine);
  engine._errToThrow = new Error("Oh no!");
  await SyncTestingInfrastructure(server);
  try {
    let ping = await sync_and_validate_telem(true);
    equal(ping.status.service, SYNC_FAILED_PARTIAL);
    ok(ping.engines.every(e => e.name !== "bogus"));
  } finally {
    await cleanAndGo(engine, server);
    await Service.engineManager.unregister(engine);
  }
});

add_task(async function test_no_foreign_engines_in_success_ping() {
  enableValidationPrefs();

  await Service.engineManager.register(BogusEngine);
  let engine = Service.engineManager.get("bogus");
  engine.enabled = true;
  let server = await serverForFoo(engine);

  await SyncTestingInfrastructure(server);
  try {
    let ping = await sync_and_validate_telem();
    ok(ping.engines.every(e => e.name !== "bogus"));
  } finally {
    await cleanAndGo(engine, server);
    await Service.engineManager.unregister(engine);
  }
});

add_task(async function test_events() {
  enableValidationPrefs();

  await Service.engineManager.register(BogusEngine);
  let engine = Service.engineManager.get("bogus");
  engine.enabled = true;
  let server = await serverForFoo(engine);

  await SyncTestingInfrastructure(server);
  try {
    let serverTime = Resource.serverTime;
    Service.recordTelemetryEvent("object", "method", "value", { foo: "bar" });
    let ping = await wait_for_ping(() => Service.sync(), true, true);
    equal(ping.events.length, 1);
    let [timestamp, category, method, object, value, extra] = ping.events[0];
    ok((typeof timestamp == "number") && timestamp > 0); // timestamp.
    equal(category, "sync");
    equal(method, "method");
    equal(object, "object");
    equal(value, "value");
    deepEqual(extra, { foo: "bar", serverTime: String(serverTime) });
    // Test with optional values.
    Service.recordTelemetryEvent("object", "method");
    ping = await wait_for_ping(() => Service.sync(), false, true);
    equal(ping.events.length, 1);
    equal(ping.events[0].length, 4);

    Service.recordTelemetryEvent("object", "method", "extra");
    ping = await wait_for_ping(() => Service.sync(), false, true);
    equal(ping.events.length, 1);
    equal(ping.events[0].length, 5);

    Service.recordTelemetryEvent("object", "method", undefined, { foo: "bar" });
    ping = await wait_for_ping(() => Service.sync(), false, true);
    equal(ping.events.length, 1);
    equal(ping.events[0].length, 6);
    [timestamp, category, method, object, value, extra] = ping.events[0];
    equal(value, null);

    Service.recordTelemetryEvent("object", "method", undefined, { foo: "bar" });
    let telem = get_sync_test_telemetry();
    // Fake a submission due to shutdown.
    ping = await wait_for_ping(() => telem.finish("shutdown"), false, true);
    equal(ping.syncs.length, 0);
    equal(ping.events.length, 1);
    equal(ping.events[0].length, 6);
  } finally {
    await cleanAndGo(engine, server);
    await Service.engineManager.unregister(engine);
  }
});

add_task(async function test_histograms() {
  enableValidationPrefs();

  await Service.engineManager.register(BogusEngine);
  let engine = Service.engineManager.get("bogus");
  engine.enabled = true;
  let server = await serverForFoo(engine);

  await SyncTestingInfrastructure(server);
  try {
    let histId = "TELEMETRY_TEST_LINEAR";
    Services.obs.notifyObservers(null, "weave:telemetry:histogram", histId);
    let ping = await wait_for_ping(() => Service.sync(), true, true);
    equal(Object.keys(ping.histograms).length, 1);
    equal(ping.histograms[histId].sum, 0);
    equal(ping.histograms[histId].histogram_type, 1);
    equal(ping.histograms[histId].counts.length, 10);
    equal(ping.histograms[histId].ranges.length, 10);
  } finally {
    await cleanAndGo(engine, server);
    await Service.engineManager.unregister(engine);
  }
});

add_task(async function test_invalid_events() {
  enableValidationPrefs();

  await Service.engineManager.register(BogusEngine);
  let engine = Service.engineManager.get("bogus");
  engine.enabled = true;
  let server = await serverForFoo(engine);

  async function checkNotRecorded(...args) {
    Service.recordTelemetryEvent.call(args);
    let ping = await wait_for_ping(() => Service.sync(), false, true);
    equal(ping.events, undefined);
  }

  await SyncTestingInfrastructure(server);
  try {
    let long21 = "l".repeat(21);
    let long81 = "l".repeat(81);
    let long86 = "l".repeat(86);
    await checkNotRecorded("object");
    await checkNotRecorded("object", 2);
    await checkNotRecorded(2, "method");
    await checkNotRecorded("object", "method", 2);
    await checkNotRecorded("object", "method", "value", 2);
    await checkNotRecorded("object", "method", "value", { foo: 2 });
    await checkNotRecorded(long21, "method", "value");
    await checkNotRecorded("object", long21, "value");
    await checkNotRecorded("object", "method", long81);
    let badextra = {};
    badextra[long21] = "x";
    await checkNotRecorded("object", "method", "value", badextra);
    badextra = { "x": long86 };
    await checkNotRecorded("object", "method", "value", badextra);
    for (let i = 0; i < 10; i++) {
      badextra["name" + i] = "x";
    }
    await checkNotRecorded("object", "method", "value", badextra);
  } finally {
    await cleanAndGo(engine, server);
    await Service.engineManager.unregister(engine);
  }
});

add_task(async function test_no_ping_for_self_hosters() {
  enableValidationPrefs();

  let telem = get_sync_test_telemetry();
  let oldSubmit = telem.submit;

  await Service.engineManager.register(BogusEngine);
  let engine = Service.engineManager.get("bogus");
  engine.enabled = true;
  let server = await serverForFoo(engine);

  await SyncTestingInfrastructure(server);
  try {
    let submitPromise = new Promise(resolve => {
      telem.submit = function() {
        let result = oldSubmit.apply(this, arguments);
        resolve(result);
      };
    });
    await Service.sync();
    let pingSubmitted = await submitPromise;
    // The Sync testing infrastructure already sets up a custom token server,
    // so we don't need to do anything to simulate a self-hosted user.
    ok(!pingSubmitted, "Should not submit ping with custom token server URL");
  } finally {
    telem.submit = oldSubmit;
    await cleanAndGo(engine, server);
    await Service.engineManager.unregister(engine);
  }
});
