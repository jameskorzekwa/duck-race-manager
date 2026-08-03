import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import localWorker, { localAccessToken } from "./local-dev.ts";

class D1Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.args) ?? null;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.args) };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

const createD1 = (database) => ({
  prepare(sql) {
    return new D1Statement(database, sql);
  },
  async batch(statements) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        const result = database.prepare(statement.sql).run(...statement.args);
        return { success: true, meta: { changes: Number(result.changes) } };
      });
      database.exec("COMMIT");
      return results;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  },
});

const createDatabase = () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrationsUrl = new URL("../db/migrations/", import.meta.url);
  for (const name of readdirSync(migrationsUrl).filter((entry) => /^\d{4}_.+\.sql$/.test(entry)).sort()) {
    database.exec(readFileSync(new URL(name, migrationsUrl), "utf8"));
  }
  return database;
};

const localOrigin = "http://localhost:8787";

const localEnv = (database) => ({
  APP_ORIGIN: localOrigin,
  AWS_REGION: "us-east-1",
  EMAIL_FROM_ADDRESS: "race@quickducks.local",
  COGNITO_USER_POOL_ID: "us-east-1_local0000",
  COGNITO_USER_POOL_CLIENT_ID: "localdevclientid",
  COGNITO_DOMAIN: localOrigin,
  DB: createD1(database),
  EMAIL_QUEUE: { async send() {} },
  PARTICIPANT_CONTACT_READ_RATE_LIMITER: { async limit() { return { success: true }; } },
  PUBLIC_SEARCH_RATE_LIMITER: { async limit() { return { success: true }; } },
});

const cookieFrom = (response, name) =>
  response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`))?.split(";")[0];

const readConfig = (name) => {
  const source = readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
  // Both configs are JSONC; the comments explain why the local one exists. Only
  // whole-line comments are stripped, so a trailing one would land here rather
  // than quietly skipping the assertions that follow.
  try {
    return JSON.parse(source.replaceAll(/^\s*\/\/.*$/gm, ""));
  } catch (cause) {
    throw new Error(`${name} is not parseable after removing whole-line comments`, { cause });
  }
};

// The single most important guarantee in this file. Everything else about local
// development is a convenience; this is what keeps it out of production.
test("the deployed configuration never points at the local entry point", () => {
  const production = readConfig("wrangler.jsonc");

  assert.equal(production.main, "src/index.ts");
  assert.equal(production.vars.APP_ORIGIN, "https://quickducks.com");
  assert.equal(production.name, "quickducks");
});

test("the local configuration is loopback-only and binds no production resource", () => {
  const local = readConfig("wrangler.local.jsonc");
  const production = readConfig("wrangler.jsonc");

  assert.equal(local.main, "src/local-dev.ts");
  assert.equal(local.vars.APP_ORIGIN, localOrigin);
  assert.notEqual(local.name, production.name);
  assert.equal("routes" in local, false);
  assert.equal(local.workers_dev, false);
  assert.equal(local.preview_urls, false);

  // The local entry point hands an administrator token to anyone who asks, so
  // it must never be able to reach a real resource — including through
  // `wrangler dev --remote`, where these identifiers are what would resolve.
  assert.notEqual(local.d1_databases[0].database_id, production.d1_databases[0].database_id);
  assert.notEqual(local.d1_databases[0].database_name, production.d1_databases[0].database_name);
  assert.notEqual(local.r2_buckets[0].bucket_name, production.r2_buckets[0].bucket_name);
  assert.notEqual(local.queues.producers[0].queue, production.queues.producers[0].queue);
  assert.notEqual(local.queues.consumers[0].queue, production.queues.consumers[0].queue);
  assert.notEqual(local.queues.consumers[0].dead_letter_queue, production.queues.consumers[0].dead_letter_queue);

  // The binding *shapes* must still match production, or local behaviour
  // diverges. Both rate limiters in particular are read without an undefined guard.
  assert.deepEqual(
    local.d1_databases.map((database) => database.binding),
    production.d1_databases.map((database) => database.binding),
  );
  assert.deepEqual(local.durable_objects, production.durable_objects);
  assert.deepEqual(
    local.r2_buckets.map((bucket) => bucket.binding),
    production.r2_buckets.map((bucket) => bucket.binding),
  );
  assert.deepEqual(
    local.queues.producers.map((producer) => producer.binding),
    production.queues.producers.map((producer) => producer.binding),
  );
  assert.equal(local.queues.consumers.length, production.queues.consumers.length);
  assert.deepEqual(local.triggers, production.triggers);
  assert.deepEqual(local.ratelimits, production.ratelimits);
});

test("no deployed module imports the local entry point", () => {
  const sources = readdirSync(new URL("./", import.meta.url))
    .filter((name) => name.endsWith(".ts") && name !== "local-dev.ts");

  for (const name of sources) {
    const source = readFileSync(new URL(name, import.meta.url), "utf8");
    assert.doesNotMatch(source, /["']\.\/local-dev\.ts["']/, `${name} must not import the local entry point`);
  }
});

test("the local entry point refuses a non-loopback configuration", async () => {
  for (const appOrigin of ["https://quickducks.com", "https://staging.quickducks.com", undefined]) {
    const response = await localWorker.fetch(
      new Request("https://quickducks.com/"),
      { APP_ORIGIN: appOrigin },
    );

    assert.equal(response.status, 500);
    assert.match(await response.text(), /Refusing to run/);
  }
});

// Covers the mistake the configuration alone cannot: `wrangler dev --remote`, or
// a deploy that publishes a preview URL, would run this module with a local
// APP_ORIGIN while serving the public internet.
test("the local entry point refuses a request that did not arrive on a local address", async () => {
  const database = createDatabase();
  const env = localEnv(database);

  for (
    const url of [
      "https://quickducks-local.someone.workers.dev/__local/staff",
      "https://quickducks.com/",
      // Private, but plain http off loopback, which cannot hold a staff session.
      "http://192.168.1.20:8787/",
    ]
  ) {
    const response = await localWorker.fetch(new Request(url, { method: "POST" }), env);
    assert.equal(response.status, 500, url);
    assert.match(await response.text(), /Refusing to run/);
  }

  // Nothing was created by the refused bootstrap attempts.
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_profiles").get().count, 0);
  database.close();
});

const networkOrigin = "https://192.168.0.252:8787";

const networkEnv = (database) => ({ ...localEnv(database), APP_ORIGIN: networkOrigin, COGNITO_DOMAIN: networkOrigin });

test("the site serves other devices when it is configured for the local network", async () => {
  const database = createDatabase();
  const env = networkEnv(database);

  const home = await localWorker.fetch(new Request(`${networkOrigin}/`), env);
  assert.equal(home.status, 200);
  // Not redirected to production, and not refused.
  assert.doesNotMatch(await home.text(), /Refusing to run/);

  const signIn = await localWorker.fetch(new Request(`${networkOrigin}/staff`), env);
  assert.equal(signIn.status, 200);
  assert.match(await signIn.text(), /Continue to secure sign in/);
  database.close();
});

// Seeding runs on the host but must address the network origin, because public
// registration checks the request Origin against APP_ORIGIN. Bootstrapping
// therefore has to answer on that origin too.
test("bootstrapping answers on the network origin so seeding can reach it", async () => {
  const database = createDatabase();
  const env = networkEnv(database);

  const bootstrap = await localWorker.fetch(
    new Request(`${networkOrigin}/__local/staff`, {
      method: "POST",
      headers: { origin: networkOrigin },
    }),
    env,
  );

  assert.equal(bootstrap.status, 200);
  assert.equal((await bootstrap.json()).accounts.length, 7);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_profiles").get().count, 7);
  database.close();
});

test("a device on the network can sign in through the stand-in hosted UI", async () => {
  const database = createDatabase();
  const env = networkEnv(database);
  await localWorker.fetch(new Request("https://localhost:8787/__local/staff", { method: "POST" }), env);

  const start = await localWorker.fetch(new Request(`${networkOrigin}/staff/login/start?returnTo=%2Fstaff`), env);
  const oauthCookie = cookieFrom(start, "__Host-quickducks_oauth");
  const authorize = await localWorker.fetch(new Request(start.headers.get("location")), env);
  const chooser = await authorize.text();
  const callbackUrl = chooser.match(/href="(https:\/\/192\.168\.0\.252:8787\/auth\/callback\?[^"]+)"/)?.[1];
  assert.ok(callbackUrl, "the chooser must return the device to the network origin");

  const callback = await localWorker.fetch(
    new Request(callbackUrl.replaceAll("&amp;", "&"), { headers: { cookie: oauthCookie } }),
    env,
  );
  assert.equal(callback.status, 303);
  const session = cookieFrom(callback, "__Host-quickducks_staff");
  assert.ok(session);

  const console = await localWorker.fetch(
    new Request(`${networkOrigin}/staff`, { headers: { cookie: session } }),
    env,
  );
  assert.match(await console.text(), /Avery Admin/);
  database.close();
});

test("the bootstrap endpoint refuses a cross-origin browser request", async () => {
  const database = createDatabase();
  const env = localEnv(database);

  const response = await localWorker.fetch(
    new Request(`${localOrigin}/__local/staff`, {
      method: "POST",
      headers: { origin: "http://evil.example" },
    }),
    env,
  );

  assert.equal(response.status, 403);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_profiles").get().count, 0);
  database.close();
});

test("the synthetic local mailbox refuses cross-origin reads", async () => {
  const database = createDatabase();
  const response = await localWorker.fetch(
    new Request(`${localOrigin}/__local/emails`, {
      headers: { origin: "https://evil.example" },
    }),
    localEnv(database),
  );
  assert.equal(response.status, 403);
  database.close();
});

test("the sign-in stand-in refuses a redirect target off the application origin", async () => {
  const database = createDatabase();
  const response = await localWorker.fetch(
    new Request(`${localOrigin}/oauth2/authorize?state=abc&redirect_uri=${encodeURIComponent("https://evil.example/auth/callback")}`),
    localEnv(database),
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /not on/);
  database.close();
});

test("bootstrapping creates the local accounts once and is safe to repeat", async () => {
  const database = createDatabase();
  const env = localEnv(database);

  const first = await localWorker.fetch(new Request(`${localOrigin}/__local/staff`, { method: "POST" }), env);
  const second = await localWorker.fetch(new Request(`${localOrigin}/__local/staff`, { method: "POST" }), env);
  const { accounts } = await second.json();

  assert.equal(first.status, 200);
  assert.equal(accounts.length, 7);
  assert.equal(accounts.filter((account) => account.isSystemAdmin).length, 1);
  assert.deepEqual(
    accounts.flatMap((account) => account.roles).sort(),
    ["ANNOUNCER", "DUCK_MANAGER", "HEAT_RUNNER", "RACE_DIRECTOR", "REGISTRATION", "RESULT_TAKER"],
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_profiles").get().count, 7);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM staff_role_assignments WHERE revoked_at IS NULL").get().count,
    6,
  );
  // An administrator holds no role rows and passes role checks implicitly.
  assert.equal(
    database.prepare(
      "SELECT COUNT(*) AS count FROM staff_role_assignments WHERE staff_profile_id = 'local-admin'",
    ).get().count,
    0,
  );
  database.close();
});

test("a bootstrapped account signs in through the real OAuth callback and reaches the console", async () => {
  const database = createDatabase();
  const env = localEnv(database);
  await localWorker.fetch(new Request(`${localOrigin}/__local/staff`, { method: "POST" }), env);

  // 1. The production login handler issues the PKCE flow cookie and redirect.
  const start = await localWorker.fetch(new Request(`${localOrigin}/staff/login/start?returnTo=%2Fstaff`), env);
  assert.equal(start.status, 302);
  const oauthCookie = cookieFrom(start, "__Host-quickducks_oauth");
  assert.ok(oauthCookie);

  // 2. The stand-in hosted UI offers every active profile.
  const authorize = await localWorker.fetch(new Request(start.headers.get("location")), env);
  const chooser = await authorize.text();
  assert.equal(authorize.status, 200);
  assert.match(chooser, /admin@quickducks\.local/);
  const callbackUrl = chooser.match(/href="(http:\/\/localhost:8787\/auth\/callback\?[^"]+)"/)?.[1];
  assert.ok(callbackUrl);

  // 3. The production callback exchanges the code and sets the session cookies.
  const callback = await localWorker.fetch(
    new Request(callbackUrl.replaceAll("&amp;", "&"), { headers: { cookie: oauthCookie } }),
    env,
  );
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get("location"), "/staff");
  const session = cookieFrom(callback, "__Host-quickducks_staff");
  const refresh = cookieFrom(callback, "__Host-quickducks_staff_refresh");
  assert.ok(session);
  assert.ok(refresh);

  // 4. The session authenticates against the real staff profile lookup.
  const console = await localWorker.fetch(
    new Request(`${localOrigin}/staff`, { headers: { cookie: session } }),
    env,
  );
  const consoleBody = await console.text();
  assert.equal(console.status, 200);
  assert.match(consoleBody, /Avery Admin/);
  assert.doesNotMatch(consoleBody, /Continue to secure sign in/);

  // 5. An expired access token is renewed from the refresh cookie alone.
  const refreshed = await localWorker.fetch(
    new Request(`${localOrigin}/api/v1/staff/session`, { headers: { cookie: refresh } }),
    env,
  );
  assert.equal(refreshed.status, 200);
  assert.deepEqual((await refreshed.json()).access, { isSystemAdmin: true, roles: [] });
  database.close();
});

test("a bearer token authenticates exactly one seeded account", async () => {
  const database = createDatabase();
  const env = localEnv(database);
  await localWorker.fetch(new Request(`${localOrigin}/__local/staff`, { method: "POST" }), env);

  const asAnnouncer = await localWorker.fetch(
    new Request(`${localOrigin}/api/v1/staff/session`, {
      headers: { authorization: `Bearer ${localAccessToken("local-announcer")}` },
    }),
    env,
  );
  assert.equal(asAnnouncer.status, 200);
  assert.deepEqual((await asAnnouncer.json()).access, { isSystemAdmin: false, roles: ["ANNOUNCER"] });

  // A subject with no staff profile is refused, so local tokens are not a
  // blanket bypass of the profile and role requirements.
  const unknown = await localWorker.fetch(
    new Request(`${localOrigin}/api/v1/staff/session`, {
      headers: { authorization: `Bearer ${localAccessToken("nobody")}` },
    }),
    env,
  );
  assert.equal(unknown.status, 401);

  const malformed = await localWorker.fetch(
    new Request(`${localOrigin}/api/v1/staff/session`, { headers: { authorization: "Bearer not-a-local-token" } }),
    env,
  );
  assert.equal(malformed.status, 401);

  // An access token is not a refresh token. Accepting one as the other would
  // shift the decoded subject rather than fail, which is the kind of asymmetry
  // that stops being harmless when a token format changes.
  const wrongTokenKind = await localWorker.fetch(
    new Request(`${localOrigin}/api/v1/staff/session`, {
      headers: { cookie: `__Host-quickducks_staff_refresh=${localAccessToken("local-admin")}` },
    }),
    env,
  );
  assert.equal(wrongTokenKind.status, 401);
  database.close();
});

test("signing out clears the session and returns to the local site", async () => {
  const database = createDatabase();
  const env = localEnv(database);

  const logout = await localWorker.fetch(
    new Request(`${localOrigin}/staff/logout`, {
      method: "POST",
      headers: { origin: localOrigin, cookie: "__Host-quickducks_staff_refresh=localdevr-bG9jYWwtYWRtaW4" },
    }),
    env,
  );
  assert.equal(logout.status, 303);
  const hostedLogout = new URL(logout.headers.get("location"));
  assert.equal(hostedLogout.pathname, "/logout");
  assert.ok(logout.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-quickducks_staff=;")));

  const landing = await localWorker.fetch(new Request(hostedLogout), env);
  assert.equal(landing.status, 303);
  assert.equal(landing.headers.get("location"), localOrigin);
  database.close();
});

test("unknown local endpoints do not fall through to the site", async () => {
  const database = createDatabase();
  const response = await localWorker.fetch(
    new Request(`${localOrigin}/__local/anything`),
    localEnv(database),
  );

  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /Unknown local development endpoint/);
  database.close();
});
