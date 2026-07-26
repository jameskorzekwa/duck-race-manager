import assert from "node:assert/strict";
import test from "node:test";

import worker from "./index.ts";

const env = {
  APP_ORIGIN: "https://quickducks.com",
};

test("redirects HTTP requests to canonical HTTPS", async () => {
  const response = await worker.fetch(
    new Request("http://quickducks.com/register?source=nfc"),
    env,
  );

  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://quickducks.com/register?source=nfc");
});

test("redirects alternate hosts to the canonical origin", async () => {
  const response = await worker.fetch(new Request("https://www.quickducks.com/"), env);

  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://quickducks.com/");
});

test("adds HSTS and browser security headers to HTML", async () => {
  const response = await worker.fetch(new Request("https://quickducks.com/"), env);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
});

test("adds security headers to JSON errors", async () => {
  const response = await worker.fetch(new Request("https://quickducks.com/missing"), env);

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
  assert.deepEqual(await response.json(), { error: "Not found" });
});
