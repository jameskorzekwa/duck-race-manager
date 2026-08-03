import assert from "node:assert/strict";
import test from "node:test";

import {
  handleLiveConnection,
  LIVE_UPDATE_DOMAINS,
  MAX_LIVE_CONNECTIONS,
  mutationRefreshDomains,
  RaceUpdates,
  scheduleRaceUpdate,
} from "./live-updates.ts";

const version = "11111111-1111-4111-8111-111111111111";

test("Durable Object broadcasts one bounded privacy-safe signal to every device", async () => {
  const received = [];
  let failedClosed = false;
  const object = new RaceUpdates({
    getWebSockets() {
      return [
        { send(value) { received.push(value); } },
        { send(value) { received.push(value); } },
        {
          send() { throw new Error("gone"); },
          close(code, reason) {
            assert.equal(code, 1011);
            assert.equal(reason, "Refresh connection");
            failedClosed = true;
          },
        },
      ];
    },
  });
  const signal = JSON.stringify({ type: "refresh", domains: ["participants", "ducks"], version });
  const response = await object.fetch(new Request("https://race-updates.internal/publish", {
    method: "POST",
    body: signal,
  }));

  assert.equal(response.status, 204);
  assert.deepEqual(received, [signal, signal]);
  assert.equal(failedClosed, true);
  assert.deepEqual(Object.keys(JSON.parse(signal)).sort(), ["domains", "type", "version"]);
  assert.equal(Object.hasOwn(JSON.parse(signal), "race"), false);

  const dataSignal = await object.fetch(new Request("https://race-updates.internal/publish", {
    method: "POST",
    body: JSON.stringify({ type: "refresh", domains: ["participants"], version, race: {} }),
  }));
  assert.equal(dataSignal.status, 400);

  for (const body of [
    JSON.stringify({ type: "refresh", domains: ["participants"], version: "participant-name" }),
    JSON.stringify({ type: "refresh", domains: ["participants", "participants"], version }),
    JSON.stringify({ type: "refresh", domains: ["private-token"], version }),
    JSON.stringify({ type: "refresh", domains: ["all", "participants"], version }),
    // The retired domain is outside the finite vocabulary and is refused.
    JSON.stringify({ type: "refresh", domains: ["returns"], version }),
    JSON.stringify({ type: "refresh", domains: ["ducks", "returns"], version }),
  ]) {
    const invalid = await object.fetch(new Request("https://race-updates.internal/publish", { method: "POST", body }));
    assert.equal(invalid.status, 400);
  }
});

test("live endpoint requires same-origin upgrades and routes to one named object", async () => {
  const plain = await handleLiveConnection(new Request("https://quickducks.com/api/v1/live"), {});
  assert.equal(plain.status, 426);
  assert.equal(plain.headers.get("upgrade"), "websocket");

  const calls = [];
  const upgrade = new Request("https://quickducks.com/api/v1/live", {
    headers: { origin: "https://quickducks.com", upgrade: "websocket" },
  });
  const routed = await handleLiveConnection(upgrade, {
    APP_ORIGIN: "https://quickducks.com",
    RACE_UPDATES: {
      idFromName(name) {
        calls.push(["name", name]);
        return "object-id";
      },
      get(id) {
        calls.push(["get", id]);
        return {
          async fetch(request) {
            calls.push(["fetch", request.url]);
            return new Response("routed");
          },
        };
      },
    },
  });

  assert.equal(await routed.text(), "routed");
  assert.deepEqual(calls, [
    ["name", "race-updates"],
    ["get", "object-id"],
    ["fetch", "https://quickducks.com/api/v1/live"],
  ]);

  const missingOrigin = await handleLiveConnection(new Request("https://quickducks.com/api/v1/live", {
    headers: { upgrade: "websocket" },
  }), {
    APP_ORIGIN: "https://quickducks.com",
    RACE_UPDATES: {
      idFromName() { throw new Error("must not route"); },
    },
  });
  assert.equal(missingOrigin.status, 403);
  const wrongOrigin = await handleLiveConnection(new Request("https://quickducks.com/api/v1/live", {
    headers: { origin: "https://example.com", upgrade: "websocket" },
  }), {
    APP_ORIGIN: "https://quickducks.com",
    RACE_UPDATES: {
      idFromName() { throw new Error("must not route"); },
    },
  });
  assert.equal(wrongOrigin.status, 403);

  const localPreview = await handleLiveConnection(new Request("http://127.0.0.1:8787/api/v1/live", {
    headers: { origin: "http://quickducks.com", upgrade: "websocket" },
  }), {
    APP_ORIGIN: "http://127.0.0.1:8787",
    RACE_UPDATES: {
      idFromName() { return "object-id"; },
      get() { return { async fetch() { return new Response("local routed"); } }; },
    },
  });
  assert.equal(await localPreview.text(), "local routed");
});

test("Durable Object caps connections and closes every client frame with policy code", async () => {
  const object = new RaceUpdates({
    getWebSockets() { return Array.from({ length: MAX_LIVE_CONNECTIONS }, () => ({})); },
  });
  const capacity = await object.fetch(new Request("https://quickducks.com/api/v1/live", {
    headers: { upgrade: "websocket" },
  }));
  assert.equal(capacity.status, 503);
  assert.match(await capacity.text(), /capacity/i);

  let closed = null;
  object.webSocketMessage({
    close(code, reason) { closed = { code, reason }; },
  });
  assert.deepEqual(closed, { code: 1008, reason: "Client messages are not accepted" });
});

test("failed best-effort publication settles inside waitUntil", async () => {
  let scheduled;
  scheduleRaceUpdate({
    RACE_UPDATES: {
      idFromName() { return "object-id"; },
      get() {
        return { async fetch() { throw new Error("Durable Object unavailable"); } };
      },
    },
  }, {
    waitUntil(promise) { scheduled = promise; },
  });

  assert.ok(scheduled);
  await assert.doesNotReject(scheduled);
});

test("successful mutation routes have explicit bounded refresh domains", () => {
  const cases = [
    ["POST", "/api/v1/registrations", ["participants"]],
    ["POST", "/api/v1/registrations/mine/duck-name", ["participants", "ducks", "heats"]],
    ["POST", "/api/v1/registrations/mine/follow", ["participants"]],
    ["POST", "/api/v1/registrations/mine/unfollow", ["participants"]],
    ["POST", "/api/v1/registrations/mine/delete", ["participants"]],
    ["POST", "/api/v1/staff/profiles", ["staff"]],
    ["POST", "/api/v1/staff/profiles/profile/role", ["staff"]],
    ["POST", "/api/v1/staff/profiles/profile/deactivate", ["staff"]],
    ["POST", "/api/v1/staff/profiles/profile/reactivate", ["staff"]],
    ["POST", "/api/v1/staff/events", ["event"]],
    ["PATCH", "/api/v1/staff/events/event/configuration", ["event"]],
    ["POST", "/api/v1/staff/events/event/open-registration", ["event", "participants"]],
    ["POST", "/api/v1/staff/events/event/start-round-one", ["event", "participants", "ducks", "heats"]],
    ["POST", "/api/v1/staff/events/event/force-delete", ["all"]],
    ["POST", "/api/v1/staff/events/event/registrations", ["participants"]],
    ["PATCH", "/api/v1/staff/registrations/registration", ["participants", "ducks", "heats"]],
    ["DELETE", "/api/v1/staff/registrations/registration", ["participants", "ducks", "heats"]],
    ["POST", "/api/v1/staff/registrations/registration/withdraw", ["participants", "ducks", "heats"]],
    ["POST", "/api/v1/staff/inventory/provisioning", ["ducks", "support"]],
    ["POST", "/api/v1/staff/inventory/provisioning/takeover", ["ducks", "support"]],
    ["POST", "/api/v1/staff/inventory/provisioning/confirm", ["ducks", "support"]],
    ["POST", "/api/v1/staff/inventory/ducks", ["ducks", "event"]],
    ["POST", "/api/v1/staff/inventory/ducks/duck/photo", ["ducks", "event"]],
    ["POST", "/api/v1/staff/inventory/ducks/duck/assignments", ["ducks", "participants", "heats"]],
    ["POST", "/api/v1/staff/inventory/ducks/duck/delete", ["ducks", "participants", "heats"]],
    ["POST", "/api/v1/staff/registrations/registration/set-duck-name", ["participants", "ducks", "heats"]],
    ["POST", "/api/v1/staff/registrations/registration/clear-duck-name", ["participants", "ducks", "heats"]],
    ["POST", "/api/v1/staff/inventory/assignments/assignment/unassign", ["ducks", "participants", "heats"]],
    ["POST", "/api/v1/staff/ducks/tag/assignments", ["ducks", "participants", "heats"]],
    ["POST", "/api/v1/staff/ducks/tag/replacement", ["ducks", "participants", "heats"]],
    ["POST", "/api/v1/staff/ducks/tag/heat-winner", ["event", "participants", "heats"]],
    ["POST", "/api/v1/staff/events/event/heats/round-one/plan-commit", ["event", "participants", "heats"]],
    ["PUT", "/api/v1/staff/events/event/heats/heat/roster", ["event", "participants", "heats"]],
    ["POST", "/api/v1/staff/events/event/heats/heat/results/finalize", ["event", "participants", "heats"]],
    ["POST", "/api/v1/staff/events/event/heats/heat/winner-announced", ["event", "participants", "heats"]],
    ["POST", "/api/v1/staff/events/event/heats/heat/start", ["event", "participants", "heats"]],
    ["POST", "/api/v1/staff/events/event/heats/heat/reset", ["event", "participants", "heats"]],
    ["POST", "/api/v1/staff/support/events/event/notifications/notification/retry", ["support"]],
  ];

  for (const [method, path, expected] of cases) {
    const actual = mutationRefreshDomains(new Request(`https://quickducks.com${path}`, { method }));
    assert.deepEqual(actual, expected, `${method} ${path}`);
    assert.ok(actual.every((domain) => LIVE_UPDATE_DOMAINS.includes(domain)));
  }
  for (const [method, path] of [
    ["GET", "/api/v1/staff/events"],
    ["GET", "/api/v1/registrations/mine"],
    ["PATCH", "/api/v1/registrations/mine/11111111-1111-4111-8111-111111111111/contact"],
    ["POST", "/api/v1/staff/events/event/heats/round-one/plan-preview"],
    ["POST", "/api/v1/staff/inventory/provisioning/classify"],
    ["POST", "/api/v1/unknown"],
    ["DELETE", "/api/v1/staff/events/event"],
    // Retired return and purge routes classify to nothing at all.
    ["POST", "/api/v1/staff/events/event/start-return-processing"],
    ["POST", "/api/v1/staff/events/event/purge-ready"],
    ["POST", "/api/v1/staff/events/event/purge-ready/cancel"],
    ["POST", "/api/v1/staff/events/event/purge"],
    ["POST", "/api/v1/staff/events/event/ducks/42/dispositions"],
    ["POST", "/api/v1/staff/ducks/tag/dispositions"],
    ["POST", "/api/v1/staff/support/events/event/return-batches"],
    ["POST", "/api/v1/staff/support/events/event/return-batches/batch/items"],
    ["POST", "/api/v1/staff/support/events/event/purge-claim"],
  ]) {
    assert.equal(mutationRefreshDomains(new Request(`https://quickducks.com${path}`, { method })), null);
  }
});

// The domain vocabulary is finite and shared with every browser client. The
// retired `returns` domain must not be publishable or accepted on a signal.
test("the live-update domain vocabulary no longer contains returns", () => {
  assert.deepEqual([...LIVE_UPDATE_DOMAINS], [
    "all",
    "event",
    "participants",
    "ducks",
    "heats",
    "staff",
    "support",
  ]);
  assert.equal(LIVE_UPDATE_DOMAINS.includes("returns"), false);
});

test("scheduled publication contains domains and random version only", async () => {
  let scheduled;
  let frame;
  scheduleRaceUpdate({
    RACE_UPDATES: {
      idFromName() { return "object-id"; },
      get() {
        return {
          async fetch(_url, init) {
            frame = init.body;
            return new Response(null, { status: 204 });
          },
        };
      },
    },
  }, {
    waitUntil(promise) { scheduled = promise; },
  }, ["participants", "ducks"]);
  await scheduled;

  const parsed = JSON.parse(frame);
  assert.deepEqual(Object.keys(parsed).sort(), ["domains", "type", "version"]);
  assert.deepEqual(parsed.domains, ["participants", "ducks"]);
  assert.equal(parsed.type, "refresh");
  assert.match(parsed.version, /^[0-9a-f-]{36}$/i);
  assert.doesNotMatch(frame, /name|email|token|code|participantId|duckId|eventId/i);
});
