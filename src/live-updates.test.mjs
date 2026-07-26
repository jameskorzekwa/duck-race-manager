import assert from "node:assert/strict";
import test from "node:test";

import {
  handleLiveConnection,
  MAX_LIVE_CONNECTIONS,
  RaceUpdates,
  scheduleRaceUpdate,
} from "./live-updates.ts";

test("Durable Object broadcasts only the supplied small refresh signal", async () => {
  const received = [];
  let failedClosed = false;
  const object = new RaceUpdates({
    getWebSockets() {
      return [
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
  const signal = JSON.stringify({ type: "refresh", version: "version-1" });
  const response = await object.fetch(new Request("https://race-updates.internal/publish", {
    method: "POST",
    body: signal,
  }));

  assert.equal(response.status, 204);
  assert.deepEqual(received, [signal]);
  assert.equal(failedClosed, true);
  assert.equal(Object.hasOwn(JSON.parse(signal), "race"), false);

  const dataSignal = await object.fetch(new Request("https://race-updates.internal/publish", {
    method: "POST",
    body: JSON.stringify({ type: "refresh", version: "version-2", race: {} }),
  }));
  assert.equal(dataSignal.status, 400);
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
