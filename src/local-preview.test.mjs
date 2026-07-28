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
test("local preview accepts loopback, and the local network only over TLS", () => {
  for (
    const origin of [
      // Loopback, either scheme: browsers treat it as a secure context already.
      "http://localhost:8787",
      "http://localhost",
      "http://127.0.0.1:8787",
      "http://[::1]:8787",
      "https://localhost:8787",
      "https://127.0.0.1:8787",
      // The host is resolved by parsing, so these normalise to loopback and are
      // genuinely local. Pinned so a rewrite to string matching fails loudly.
      "HTTP://LOCALHOST:8787",
      "http://quickducks.com@localhost/",
      "http://127.1",
      "http://2130706433",
      "http://[0:0:0:0:0:0:0:1]",
      // Private addresses on the local network, over TLS.
      "https://192.168.0.252:8787",
      "https://10.1.2.3:8787",
      "https://172.16.0.9:8787",
      "https://172.31.255.254:8787",
      "https://169.254.7.7:8787",
      "https://[fd12:3456::1]:8787",
      "https://[fe80::1]:8787",
      "https://j2k-macbook-pro.local:8787",
    ]
  ) {
    assert.equal(isLocalPreviewOrigin(origin), true, origin);
  }

  for (
    const origin of [
      productionOrigin,
      "http://quickducks.com",
      "http://localhost.quickducks.com",
      "http://notlocalhost",
      "http://localhost.evil.example",
      "http://127.0.0.1.evil.example",
      "http://localhost@evil.example",
      "http://localhost.",
      "http://[::ffff:127.0.0.1]",
      "http://[::2]",
      // A private address is only a local preview over TLS. Plain http cannot
      // store the `__Host-` session cookies off loopback, so it must not qualify.
      "http://192.168.1.20:8787",
      "http://10.1.2.3",
      "https://192.168.1.20.nip.io",
      "https://10.0.0.1.evil.example",
      // Public addresses that are one octet away from a private range.
      "https://172.15.0.1",
      "https://172.32.0.1",
      "https://11.0.0.1",
      "https://193.168.0.1",
      "https://8.8.8.8",
      "https://local",
      "https://notlocal.example",
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

// The page must offer the bypass form on exactly the configurations where
// `createRegistration` waives verification. Deriving the two from different
// inputs is how a form gets rendered ready and then rejected on submit.
test("the page and the API agree about protection on every key combination", async (context) => {
  const combinations = [
    { keys: {}, waived: true },
    { keys: { TURNSTILE_SITE_KEY: "site-key-test" }, waived: true },
    { keys: { TURNSTILE_SECRET_KEY: "secret-key-test" }, waived: false },
    { keys: { TURNSTILE_SITE_KEY: "site-key-test", TURNSTILE_SECRET_KEY: "secret-key-test" }, waived: false },
  ];

  for (const { keys, waived } of combinations) {
    const label = JSON.stringify(keys);
    const env = { ...registrationEnv(localOrigin), ...keys };
    const page = await (await worker.fetch(new Request(`${localOrigin}/register`), env)).text();
    assert.equal(/name="cf-turnstile-response"/.test(page), waived, `page bypass field ${label}`);

    let verified = false;
    context.mock.method(globalThis, "fetch", async () => {
      verified = true;
      return Response.json({ success: false });
    });
    await worker.fetch(
      new Request(`${localOrigin}/api/v1/registrations`, {
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
      env,
    );
    context.mock.restoreAll();
    assert.equal(verified, !waived, `API verification ${label}`);
  }
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
