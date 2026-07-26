import assert from "node:assert/strict";
import test from "node:test";

import {
  finishLineScript,
  finishHandoffHelpersScript,
  finishNfcHelpersScript,
  finishScanSerializationScript,
  finishSelectionValidationScript,
  liveScript,
  liveRuntimeHelpersScript,
  registrationScript,
  stationStateHelpersScript,
  staffDuckScript,
  staffHomeScript,
  startLineScript,
} from "./client-scripts.ts";

test("browser clients are valid JavaScript and target protected APIs", () => {
  assert.doesNotThrow(() => new Function(registrationScript));
  assert.doesNotThrow(() => new Function(staffDuckScript));
  assert.doesNotThrow(() => new Function(staffHomeScript));
  assert.doesNotThrow(() => new Function(liveScript));
  assert.doesNotThrow(() => new Function(startLineScript));
  assert.doesNotThrow(() => new Function(finishLineScript));
  assert.match(registrationScript, /\/api\/v1\/registrations/);
  assert.match(registrationScript, /publicNamePolicy/);
  assert.match(registrationScript, /Your name will appear publicly as/);
  assert.match(registrationScript, /Your email and phone stay private/);
  assert.match(staffDuckScript, /\/api\/v1\/staff\/ducks/);
  assert.match(staffDuckScript, /\/api\/v1\/staff\/registrations\/search/);
  assert.match(staffDuckScript, /\/dispositions/);
  assert.match(staffHomeScript, /\/api\/v1\/staff\/events\/return-review/);
  assert.match(staffHomeScript, /\/purge-ready/);
  assert.match(staffHomeScript, /\/api\/v1\/staff\/profiles/);
  assert.match(staffHomeScript, /Regular staff/);
  assert.match(staffHomeScript, /Administrator/);
});

test("live clients build safe DOM and retain reconnect plus polling fallback", () => {
  for (const script of [liveScript, startLineScript, finishLineScript]) {
    assert.doesNotMatch(script, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
    assert.match(script, /new WebSocket/);
    assert.match(script, /liveReconnectDelay/);
    assert.match(script, /15000/);
    assert.match(script, /liveCreatePollScheduler/);
    assert.doesNotMatch(script, /setInterval/);
    assert.match(script, /replaceChildren/);
    assert.match(script, /textContent/);
  }
  assert.match(liveScript, /\/api\/v1\/race-board/);
  assert.match(liveScript, /\/api\/v1\/registrations\/mine/);
  assert.match(liveScript, /Updates are delayed/);
  assert.match(liveScript, /personal details are delayed/);
  assert.match(startLineScript, /PLANNED: \["lock"/);
  assert.match(startLineScript, /CALLING: \["start"/);
  assert.doesNotMatch(startLineScript, /\/results\/finalize|\["finish"/);
  assert.match(finishLineScript, /NDEFReader/);
  assert.match(finishLineScript, /That duck is already selected/);
  assert.match(finishLineScript, /That duck is not in the selected heat/);
  assert.match(finishLineScript, /finishSelected\.length !== finishRequiredPlaces/);
  assert.match(finishLineScript, /\/results\/finalize/);
});

test("station state helpers prioritize unpublished results and stable render keys", () => {
  const helpers = new Function(
    `${stationStateHelpersScript}; return { startPickHeat, finishPickHeat, stationHeatRenderKey };`,
  )();
  const heats = [
    { id: "new-running", round: "ROUND_ONE", status: "RUNNING", revision: 5 },
    { id: "next", round: "ROUND_ONE", status: "CALLING", revision: 3 },
    { id: "pending", round: "ROUND_ONE", status: "AWAITING_RESULT", revision: 8 },
  ];

  assert.equal(helpers.startPickHeat(heats, "ROUND_ONE").id, "pending");
  assert.equal(helpers.finishPickHeat(heats, "ROUND_ONE").id, "pending");
  assert.equal(
    helpers.stationHeatRenderKey({ id: "event" }, { heat: heats[2] }),
    "event:pending:8:AWAITING_RESULT",
  );
});

test("live runtime helpers coalesce refreshes and switch fake poll timers", async () => {
  const helpers = new Function(
    `${liveRuntimeHelpersScript}; return { livePollDelay, liveReconnectDelay, liveSuccessfulFreshness, liveCreateRefreshQueue, liveCreatePollScheduler };`,
  )();
  assert.equal(helpers.livePollDelay(false), 5000);
  assert.equal(helpers.livePollDelay(true), 30000);
  assert.equal(helpers.liveReconnectDelay(0, 0), 800);
  assert.equal(helpers.liveReconnectDelay(0, 1), 1200);
  assert.equal(helpers.liveReconnectDelay(8, 1), 15000);
  assert.equal(helpers.liveSuccessfulFreshness([{ status: "fulfilled" }]), "Updated just now.");
  assert.match(
    helpers.liveSuccessfulFreshness([{ status: "fulfilled" }, { status: "rejected" }]),
    /public race board is current, but personal details are delayed/i,
  );

  let release;
  let refreshes = 0;
  const firstRefresh = new Promise((resolve) => { release = resolve; });
  const queued = helpers.liveCreateRefreshQueue(async () => {
    refreshes += 1;
    if (refreshes === 1) await firstRefresh;
  }, () => false);
  const first = queued();
  const second = queued();
  assert.equal(first, second);
  assert.equal(refreshes, 1);
  release();
  await first;
  assert.equal(refreshes, 2);

  let hidden = false;
  const timers = new Map();
  let nextTimer = 0;
  const scheduler = helpers.liveCreatePollScheduler(
    async () => {},
    () => hidden,
    (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    (id) => timers.delete(id),
  );
  scheduler.schedule(false);
  assert.deepEqual([...timers.values()].map((timer) => timer.delay), [5000]);
  scheduler.schedule(true);
  assert.deepEqual([...timers.values()].map((timer) => timer.delay), [30000]);
  hidden = true;
  scheduler.schedule(true);
  assert.equal(timers.size, 0);
});

test("finish selection rejects wrong-heat and duplicate race entries", () => {
  const validate = new Function(
    `${finishSelectionValidationScript}; return finishSelectionProblem;`,
  )();
  const roster = [{ raceEntryId: "entry-1" }, { raceEntryId: "entry-2" }];

  assert.equal(validate([], roster, "entry-1"), null);
  assert.equal(validate([{ raceEntryId: "entry-1" }], roster, "entry-1"), "duplicate");
  assert.equal(validate([], roster, "entry-other"), "wrong-heat");
});

test("finish scans serialize rapid lookups, preserve place order, and discard stale responses", async () => {
  const { finishCreateSerializedSelector } = new Function(
    `${finishScanSerializationScript}; return { finishCreateSerializedSelector };`,
  )();
  let context = { eventId: "event", heatId: "heat", revision: 4, intendedPlace: 1 };
  const lookups = [];
  const accepted = [];
  const busy = [];
  let stale = 0;
  const selector = finishCreateSerializedSelector({
    readContext: () => ({ ...context }),
    setBusy: (value) => busy.push(value),
    lookup: (value) => new Promise((resolve) => lookups.push({ value, resolve })),
    accept: (selection, captured) => accepted.push({ selection, place: captured.intendedPlace }),
    stale: () => { stale += 1; },
  });

  const first = selector("duck-1");
  const ignored = await selector("duck-2");
  assert.deepEqual(ignored, { accepted: false, reason: "busy" });
  assert.equal(lookups.length, 1);
  lookups[0].resolve({ raceEntryId: "entry-1" });
  assert.deepEqual(await first, { accepted: true, place: 1 });

  context = { ...context, intendedPlace: 2 };
  const second = selector("duck-2");
  lookups[1].resolve({ raceEntryId: "entry-2" });
  assert.deepEqual(await second, { accepted: true, place: 2 });
  assert.deepEqual(accepted.map((item) => item.place), [1, 2]);
  assert.deepEqual(busy, [true, false, true, false]);

  context = { ...context, intendedPlace: 3 };
  const staleLookup = selector("duck-3");
  context = { ...context, revision: 5 };
  lookups[2].resolve({ raceEntryId: "entry-3" });
  assert.deepEqual(await staleLookup, { accepted: false, reason: "stale" });
  assert.equal(stale, 1);
  assert.deepEqual(accepted.map((item) => item.place), [1, 2]);
});

test("NFC scanning cleans up unsupported records and read errors so one retry can start", async () => {
  const { finishCreateNfcScanner } = new Function(
    `${finishNfcHelpersScript}; return { finishCreateNfcScanner };`,
  )();
  const readers = [];
  const active = [];
  const values = [];
  let unsupported = 0;
  let readingErrors = 0;
  class FakeReader {
    listeners = new Map();
    scanCalls = 0;
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    removeEventListener(name, listener) {
      if (this.listeners.get(name) === listener) this.listeners.delete(name);
    }
    async scan() { this.scanCalls += 1; }
    emit(name, event = {}) { return this.listeners.get(name)?.(event); }
  }
  const scanner = finishCreateNfcScanner({
    createReader: () => {
      const reader = new FakeReader();
      readers.push(reader);
      return reader;
    },
    createController: () => ({ signal: {}, abort() {} }),
    decode: (record) => record.value,
    onValue: async (value) => { values.push(value); },
    onUnsupported: () => { unsupported += 1; },
    onReadingError: () => { readingErrors += 1; },
    onStartError: () => assert.fail("scan should start"),
    setActive: (value) => active.push(value),
  });

  assert.equal(await scanner(), true);
  assert.equal(await scanner(), false);
  assert.equal(readers.length, 1);
  await readers[0].emit("reading", { message: { records: [{ recordType: "mime" }] } });
  assert.equal(unsupported, 1);
  assert.equal(readers[0].listeners.size, 0);

  assert.equal(await scanner(), true);
  readers[1].emit("readingerror");
  assert.equal(readingErrors, 1);
  assert.equal(readers[1].listeners.size, 0);

  assert.equal(await scanner(), true);
  const reading = readers[2].emit("reading", {
    message: { records: [{ recordType: "url", value: "https://quickducks.com/t/token" }] },
  });
  readers[2].emit("reading", {
    message: { records: [{ recordType: "url", value: "duplicate" }] },
  });
  await reading;
  assert.deepEqual(values, ["https://quickducks.com/t/token"]);
  assert.deepEqual(active, [true, false, true, false, true, false]);
  assert.deepEqual(readers.map((reader) => reader.scanCalls), [1, 1, 1]);
});

test("handoff helpers reject expired, wrong-heat, and stale-revision scans", () => {
  const helpers = new Function(
    `${finishHandoffHelpersScript}; return { finishParseHandoff, finishBuildHandoffSearch, finishHandoffProblem };`,
  )();
  const stored = {
    returnPath: "/staff/finish-line",
    eventId: "event-1",
    heatId: "heat-1",
    revision: 7,
    expiresAt: 10_000,
  };
  const token = "a".repeat(32);
  const handoff = helpers.finishParseHandoff("?" + helpers.finishBuildHandoffSearch(stored, token));
  const current = { eventId: "event-1", heatId: "heat-1", revision: 7, status: "AWAITING_RESULT" };

  assert.equal(helpers.finishHandoffProblem(handoff, current, 9_000), null);
  assert.equal(helpers.finishHandoffProblem(handoff, current, 10_000), "expired");
  assert.equal(helpers.finishHandoffProblem(handoff, { ...current, heatId: "heat-2" }, 9_000), "wrong-heat");
  assert.equal(helpers.finishHandoffProblem(handoff, { ...current, revision: 8 }, 9_000), "stale-revision");
  assert.equal(helpers.finishHandoffProblem(handoff, { ...current, status: "RUNNING" }, 9_000), "not-awaiting");
});

test("staff duck scan hands complete iPhone context back without submitting", () => {
  const token = "a".repeat(32);
  const context = {
    returnPath: "/staff/finish-line",
    eventId: "event-1",
    heatId: "heat-1",
    revision: 7,
    expiresAt: Date.now() + 60_000,
  };
  const values = new Map([[
    "quickducks.finishStation",
    JSON.stringify(context),
  ]]);
  const localStorage = {
    getItem(key) { return values.get(key) ?? null; },
    removeItem(key) { values.delete(key); },
  };
  let destination = null;
  const location = {
    pathname: `/staff/ducks/${token}`,
    replace(value) { destination = value; },
  };

  new Function("document", "location", "localStorage", staffDuckScript)(null, location, localStorage);

  const destinationUrl = new URL(destination, "https://quickducks.com");
  assert.equal(destinationUrl.pathname, "/staff/finish-line");
  assert.deepEqual(Object.fromEntries(destinationUrl.searchParams), {
    tag: token,
    eventId: context.eventId,
    heatId: context.heatId,
    revision: String(context.revision),
    expiresAt: String(context.expiresAt),
  });
  assert.equal(values.has("quickducks.finishStation"), false);
  assert.doesNotMatch(destination, /submit|result/i);
});
