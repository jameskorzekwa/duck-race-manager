import assert from "node:assert/strict";
import test from "node:test";

import worker from "./index.ts";
import { isLocalPreviewOrigin, localPreviewTurnstileToken } from "./local-preview.ts";
import { renderRegistration } from "./site.ts";
import { createCognitoStaffLifecycle, createCognitoStaffProvisioner } from "./staff-access.ts";

const productionOrigin = "https://quickducks.com";
const localOrigin = "http://localhost:8787";

// The whole local-development harness hangs off this one predicate. If it ever
// returns true for an origin a deployment could actually use, the Turnstile
// waiver and the Cognito stand-ins become reachable in production.
test("local preview is limited to http loopback origins", () => {
  for (const origin of ["http://localhost:8787", "http://localhost", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
    assert.equal(isLocalPreviewOrigin(origin), true, origin);
  }

  for (
    const origin of [
      productionOrigin,
      "https://localhost:8787",
      "https://127.0.0.1",
      "http://localhost.quickducks.com",
      "http://quickducks.com",
      "http://notlocalhost",
      "http://localhost.evil.example",
      "http://127.0.0.1.evil.example",
      "http://[::2]",
      "//localhost:8787",
      "localhost:8787",
      "",
      "not a url",
    ]
  ) {
    assert.equal(isLocalPreviewOrigin(origin), false, origin);
  }
});

// Enough of a database to reach the Turnstile gate: one open event, which is the
// only row `createRegistration` reads before it decides whether to verify.
const registrationEnv = (appOrigin, status = "REGISTRATION_OPEN") => {
  const row = {
    ok: 1,
    status,
    id: "event-test",
    email_required: 0,
    registration_opens_at: null,
    registration_closes_at: null,
  };
  // Only the events query resolves. Everything else — notably the command replay
  // lookup that runs first — must miss, or the request never reaches the gate
  // under test.
  const statement = (sql) => {
    const self = {
      bind: () => self,
      async first() {
        return / FROM events\b/.test(sql) ? row : null;
      },
      async all() {
        return { results: [] };
      },
    };
    return self;
  };
  return {
    APP_ORIGIN: appOrigin,
    AWS_REGION: "us-east-1",
    COGNITO_USER_POOL_ID: "us-east-1_example",
    COGNITO_USER_POOL_CLIENT_ID: "client-example",
    COGNITO_DOMAIN: "https://quickducks-staff.example.com",
    DB: { prepare: (sql) => statement(sql) },
  };
};

test("a deployment without Turnstile keys still refuses to register", async () => {
  const response = await worker.fetch(
    new Request(`${productionOrigin}/api/v1/registrations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventId: "event-test",
        commandId: crypto.randomUUID(),
        privateToken: "a".repeat(43),
        firstName: "Daisy",
        lastName: "Duck",
        turnstileToken: localPreviewTurnstileToken,
      }),
    }),
    registrationEnv(productionOrigin),
  );

  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /protection is not configured/i);
});

test("a local preview waives Turnstile but still demands a token", async () => {
  const missingToken = await worker.fetch(
    new Request(`${localOrigin}/api/v1/registrations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventId: "event-test",
        commandId: crypto.randomUUID(),
        privateToken: "a".repeat(43),
        firstName: "Daisy",
        lastName: "Duck",
      }),
    }),
    registrationEnv(localOrigin),
  );

  // 422 proves the waiver did not skip the rest of the check: the request shape
  // a browser sends is still required, so local and deployed traffic match.
  assert.equal(missingToken.status, 422);
  assert.match((await missingToken.json()).error, /verification is required/i);
});

test("the registration page offers a submittable form only in a local preview", () => {
  const deployed = renderRegistration(undefined, "REGISTRATION");
  assert.match(deployed, /data-protection-ready="false"/);
  assert.match(deployed, /Registration protection is still being configured/);
  assert.doesNotMatch(deployed, /cf-turnstile-response/);

  const local = renderRegistration(undefined, "REGISTRATION", true);
  assert.match(local, /data-protection-ready="true"/);
  assert.match(local, /Local preview — registration protection is bypassed/);
  assert.match(
    local,
    new RegExp(`<input type="hidden" name="cf-turnstile-response" value="${localPreviewTurnstileToken}">`),
  );

  // A configured site key always wins, so a local preview that does have keys
  // renders and verifies the real widget.
  const configured = renderRegistration("site-key-test", "REGISTRATION", true);
  assert.match(configured, /data-sitekey="site-key-test"/);
  assert.doesNotMatch(configured, /cf-turnstile-response/);
});

test("the registration page keeps rendering the real widget when keys are configured", async () => {
  const response = await worker.fetch(
    new Request(`${localOrigin}/register`),
    { ...registrationEnv(localOrigin), TURNSTILE_SITE_KEY: "site-key-test", TURNSTILE_SECRET_KEY: "secret-key-test" },
  );
  const body = await response.text();

  assert.match(body, /data-sitekey="site-key-test"/);
  assert.doesNotMatch(body, /Local preview/);
});

const failingClient = () => {
  throw new Error("A local preview must never construct a Cognito client.");
};

test("staff identity operations are answered locally instead of calling Cognito", async () => {
  const provisioner = createCognitoStaffProvisioner(failingClient);
  const lifecycle = createCognitoStaffLifecycle(failingClient);
  const env = { APP_ORIGIN: localOrigin, COGNITO_USER_POOL_ID: "us-east-1_example" };

  const identity = await provisioner.create("dev@quickducks.local", "Dev Staff", env);
  assert.equal(identity.username, "dev@quickducks.local");
  assert.equal(identity.created, true);
  // Namespaced so a local subject can never be mistaken for a Cognito subject.
  assert.match(identity.cognitoSub, /^local-preview-/);

  await provisioner.delete(identity.username, env);
  await lifecycle.disable(identity.username, env);
  await lifecycle.enable(identity.username, env);
  await lifecycle.globalSignOut(identity.username, env);
});

test("staff identity operations still reach Cognito for a deployed origin", async () => {
  const provisioner = createCognitoStaffProvisioner(failingClient);
  const lifecycle = createCognitoStaffLifecycle(failingClient);
  const env = { APP_ORIGIN: productionOrigin, COGNITO_USER_POOL_ID: "us-east-1_example" };

  await assert.rejects(
    () => provisioner.create("staff@example.com", "Staff", env),
    /never construct a Cognito client/,
  );
  await assert.rejects(() => provisioner.delete("staff@example.com", env), /never construct a Cognito client/);
  await assert.rejects(() => lifecycle.disable("staff@example.com", env), /never construct a Cognito client/);
  await assert.rejects(() => lifecycle.enable("staff@example.com", env), /never construct a Cognito client/);
  await assert.rejects(() => lifecycle.globalSignOut("staff@example.com", env), /never construct a Cognito client/);
});
