import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateStaffSession,
  completeStaffLogin,
  finishStaffLoginResponse,
  staffLogoutResponse,
  startStaffLogin,
} from "./staff-session.ts";

const env = {
  APP_ORIGIN: "https://quickducks.com",
  COGNITO_DOMAIN: "https://quickducks-staff.example.com",
  COGNITO_USER_POOL_CLIENT_ID: "client-example",
};

const actor = {
  id: "staff_test",
  cognitoSub: "staff-sub",
  email: "staff@example.com",
  displayName: "Staff Member",
  isSystemAdmin: false,
  roles: ["REGISTRATION"],
  authentication: "bearer",
};

test("starts Cognito authorization-code login with state and PKCE", async () => {
  const response = await startStaffLogin(
    new Request("https://quickducks.com/staff/login/start?returnTo=%2Fstaff%2Fducks%2Ftag123"),
    env,
  );
  const location = new URL(response.headers.get("location"));
  const cookie = response.headers.get("set-cookie");
  const encodedFlow = cookie.match(/__Host-quickducks_oauth=([^;]+)/)[1];
  const flow = JSON.parse(decodeURIComponent(encodedFlow));

  assert.equal(response.status, 302);
  assert.equal(location.origin, env.COGNITO_DOMAIN);
  assert.equal(location.pathname, "/oauth2/authorize");
  assert.equal(location.searchParams.get("response_type"), "code");
  assert.equal(location.searchParams.get("client_id"), env.COGNITO_USER_POOL_CLIENT_ID);
  assert.equal(location.searchParams.get("redirect_uri"), "https://quickducks.com/auth/callback");
  assert.equal(location.searchParams.get("state"), flow.state);
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.match(location.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(location.searchParams.get("code_challenge"), flow.verifier);
  assert.equal(flow.returnTo, "/staff/ducks/tag123");
  assert.match(cookie, /HttpOnly/);
});

test("exchanges the Cognito code and creates access and refresh sessions", async () => {
  const start = await startStaffLogin(
    new Request("https://quickducks.com/staff/login/start?returnTo=%2Fstaff"),
    env,
  );
  const cookie = start.headers.get("set-cookie").split(";")[0];
  const flow = JSON.parse(decodeURIComponent(cookie.split("=").slice(1).join("=")));
  let tokenRequest;
  const completion = await completeStaffLogin(
    new Request(`https://quickducks.com/auth/callback?code=code-test&state=${flow.state}`, {
      headers: { cookie },
    }),
    env,
    async (request) => {
      assert.equal(request.headers.get("authorization"), "Bearer valid.jwt.token");
      return actor;
    },
    async (url, options) => {
      tokenRequest = { url: url.toString(), options };
      return Response.json({
        access_token: "valid.jwt.token",
        refresh_token: "valid.refresh.token",
        expires_in: 900,
      });
    },
  );

  assert.equal(completion.ok, true);
  assert.equal(completion.returnTo, "/staff");
  assert.equal(tokenRequest.url, "https://quickducks-staff.example.com/oauth2/token");
  const tokenBody = new URLSearchParams(tokenRequest.options.body);
  assert.equal(tokenBody.get("grant_type"), "authorization_code");
  assert.equal(tokenBody.get("code"), "code-test");
  assert.equal(tokenBody.get("code_verifier"), flow.verifier);

  const response = finishStaffLoginResponse(completion);
  const sessionCookies = response.headers.get("set-cookie");
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/staff");
  assert.match(sessionCookies, /__Host-quickducks_staff=valid\.jwt\.token/);
  assert.match(sessionCookies, /Max-Age=900/);
  assert.match(sessionCookies, /__Host-quickducks_staff_refresh=valid\.refresh\.token/);
  assert.match(sessionCookies, /Max-Age=604800/);
  assert.match(sessionCookies, /Secure/);
  assert.match(sessionCookies, /HttpOnly/);
  assert.match(sessionCookies, /SameSite=Lax/);
  assert.match(sessionCookies, /__Host-quickducks_oauth=/);
});

test("rejects a Cognito code exchange without a refresh token", async () => {
  const start = await startStaffLogin(new Request("https://quickducks.com/staff/login/start"), env);
  const cookie = start.headers.get("set-cookie").split(";")[0];
  const flow = JSON.parse(decodeURIComponent(cookie.split("=").slice(1).join("=")));
  const completion = await completeStaffLogin(
    new Request(`https://quickducks.com/auth/callback?code=code-test&state=${flow.state}`, {
      headers: { cookie },
    }),
    env,
    async () => actor,
    async () => Response.json({ access_token: "valid.jwt.token", expires_in: 900 }),
  );

  assert.deepEqual(completion, {
    ok: false,
    status: 502,
    error: "Cognito returned an invalid staff session.",
  });
});

test("rotates Cognito access and refresh tokens while preserving cookie authentication", async () => {
  let tokenRequest;
  const request = new Request("https://quickducks.com/api/v1/staff/events", {
    method: "POST",
    headers: {
      cookie: "__Host-quickducks_staff=expired.jwt.token; __Host-quickducks_staff_refresh=old.refresh.token",
    },
    body: "body-remains-available",
  });
  const result = await authenticateStaffSession(
    request,
    env,
    async (request) => request.headers.get("cookie") === "__Host-quickducks_staff=new.jwt.token"
      ? actor
      : null,
    async (url, options) => {
      tokenRequest = { url: url.toString(), options };
      return Response.json({
        access_token: "new.jwt.token",
        refresh_token: "new.refresh.token",
        expires_in: 7_200,
      });
    },
  );

  assert.equal(tokenRequest.url, "https://quickducks-staff.example.com/oauth2/token");
  const tokenBody = new URLSearchParams(tokenRequest.options.body);
  assert.equal(tokenBody.get("grant_type"), "refresh_token");
  assert.equal(tokenBody.get("client_id"), env.COGNITO_USER_POOL_CLIENT_ID);
  assert.equal(tokenBody.get("refresh_token"), "old.refresh.token");
  assert.equal(result.actor.authentication, "cookie");
  assert.match(result.setCookies[0], /__Host-quickducks_staff=new\.jwt\.token/);
  assert.match(result.setCookies[0], /Max-Age=900/);
  assert.match(result.setCookies[1], /__Host-quickducks_staff_refresh=new\.refresh\.token/);
  assert.match(result.setCookies[1], /Max-Age=604800/);
  assert.equal(await request.text(), "body-remains-available");
});

for (const status of [400, 401]) {
  test(`clears both staff cookies when Cognito rejects refresh credentials with ${status}`, async () => {
    const result = await authenticateStaffSession(
      new Request("https://quickducks.com/staff", {
        headers: { cookie: "__Host-quickducks_staff_refresh=invalidated.refresh.token" },
      }),
      env,
      async () => null,
      async () => Response.json({ error: "provider details must stay private" }, { status }),
    );

    assert.equal(result.actor, null);
    assert.equal(result.setCookies.length, 2);
    assert.match(result.setCookies[0], /__Host-quickducks_staff=;/);
    assert.match(result.setCookies[1], /__Host-quickducks_staff_refresh=;/);
  });
}

test("clears both staff cookies after a malformed successful refresh response", async () => {
  for (const tokenFetch of [
    async () => Response.json({ access_token: "new.jwt.token" }),
    async () => new Response("not-json", { status: 200 }),
  ]) {
    const result = await authenticateStaffSession(
      new Request("https://quickducks.com/staff", {
        headers: { cookie: "__Host-quickducks_staff_refresh=old.refresh.token" },
      }),
      env,
      async () => null,
      tokenFetch,
    );

    assert.equal(result.actor, null);
    assert.equal(result.setCookies.length, 2);
    assert.match(result.setCookies[0], /__Host-quickducks_staff=;/);
    assert.match(result.setCookies[1], /__Host-quickducks_staff_refresh=;/);
  }
});

test("preserves the refresh cookie across transient provider and network failures", async () => {
  const transientFetches = [
    async () => { throw new Error("provider network details must stay private"); },
    ...[408, 429, 500, 502, 503].map((status) => async () => new Response("provider details", { status })),
  ];
  for (const tokenFetch of transientFetches) {
    const result = await authenticateStaffSession(
      new Request("https://quickducks.com/staff", {
        headers: {
          cookie: "__Host-quickducks_staff=expired.jwt.token; __Host-quickducks_staff_refresh=retryable.refresh.token",
        },
      }),
      env,
      async () => null,
      tokenFetch,
    );

    assert.deepEqual(result, { actor: null, setCookies: [] });
  }
});

test("does not refresh requests carrying Bearer authorization", async () => {
  let refreshCalled = false;
  const result = await authenticateStaffSession(
    new Request("https://quickducks.com/api/v1/staff/events", {
      headers: {
        authorization: "Bearer expired.jwt.token",
        cookie: "__Host-quickducks_staff_refresh=valid.refresh.token",
      },
    }),
    env,
    async () => null,
    async () => {
      refreshCalled = true;
      throw new Error("must not refresh");
    },
  );

  assert.equal(refreshCalled, false);
  assert.deepEqual(result, { actor: null, setCookies: [] });
});

test("rejects an OAuth callback with mismatched state", async () => {
  const start = await startStaffLogin(new Request("https://quickducks.com/staff/login/start"), env);
  const cookie = start.headers.get("set-cookie").split(";")[0];
  const completion = await completeStaffLogin(
    new Request("https://quickducks.com/auth/callback?code=code-test&state=wrong", {
      headers: { cookie },
    }),
    env,
  );

  assert.deepEqual(completion, {
    ok: false,
    status: 400,
    error: "Cognito could not verify this sign-in request. Start again.",
  });
});

test("revokes best-effort, clears both local cookies, and redirects through Cognito logout", async () => {
  let revokeRequest;
  const response = await staffLogoutResponse(
    new Request("https://quickducks.com/staff/logout", {
      method: "POST",
      headers: {
        cookie: "__Host-quickducks_staff_refresh=valid.refresh.token",
        origin: env.APP_ORIGIN,
      },
    }),
    env,
    async (url, options) => {
      revokeRequest = { url: url.toString(), options };
      throw new Error("provider unavailable");
    },
  );
  const location = new URL(response.headers.get("location"));

  assert.equal(response.status, 303);
  assert.equal(location.pathname, "/logout");
  assert.equal(location.searchParams.get("client_id"), env.COGNITO_USER_POOL_CLIENT_ID);
  assert.equal(location.searchParams.get("logout_uri"), env.APP_ORIGIN);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(response.headers.get("content-disposition"), null);
  const revokeBody = new URLSearchParams(revokeRequest.options.body);
  assert.equal(revokeRequest.url, "https://quickducks-staff.example.com/oauth2/revoke");
  assert.equal(revokeBody.get("client_id"), env.COGNITO_USER_POOL_CLIENT_ID);
  assert.equal(revokeBody.get("token"), "valid.refresh.token");
  assert.deepEqual(response.headers.getSetCookie(), [
    "__Host-quickducks_staff=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
    "__Host-quickducks_staff_refresh=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
  ]);
  assert.equal(await response.text(), "");
});

test("completes local logout when Cognito revocation returns non-2xx", async () => {
  let revokeCalled = false;
  const response = await staffLogoutResponse(
    new Request("https://quickducks.com/staff/logout", {
      method: "POST",
      headers: {
        cookie: "__Host-quickducks_staff_refresh=valid.refresh.token",
        referer: "https://quickducks.com/staff/start-line",
      },
    }),
    env,
    async () => {
      revokeCalled = true;
      return Response.json({ error: "provider details must stay private" }, { status: 503 });
    },
  );

  assert.equal(revokeCalled, true);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.match(response.headers.get("location"), /^https:\/\/quickducks-staff\.example\.com\/logout/);
});

test("logs out without cookies without making a revocation request", async () => {
  let revokeCalls = 0;
  const response = await staffLogoutResponse(
    new Request("https://quickducks.com/staff/logout", {
      method: "POST",
      headers: { origin: env.APP_ORIGIN },
    }),
    env,
    async () => {
      revokeCalls += 1;
      return new Response(null, { status: 200 });
    },
  );

  assert.equal(revokeCalls, 0);
  assert.equal(response.status, 303);
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(response.headers.get("content-disposition"), null);
  assert.match(response.headers.get("location"), /^https:\/\/quickducks-staff\.example\.com\/logout/);
  assert.equal(await response.text(), "");
});

test("rejects logout without a same-origin POST before revocation or cookie clearing", async () => {
  let revokeCalls = 0;
  const revokeFetch = async () => {
    revokeCalls += 1;
    return new Response(null, { status: 200 });
  };
  const requests = [
    new Request("https://quickducks.com/staff/logout", {
      headers: { cookie: "__Host-quickducks_staff_refresh=valid.refresh.token", referer: "https://attacker.example/" },
    }),
    new Request("https://quickducks.com/staff/logout", {
      method: "POST",
      headers: { cookie: "__Host-quickducks_staff_refresh=valid.refresh.token", origin: "https://attacker.example" },
    }),
    new Request("https://quickducks.com/staff/logout", {
      method: "POST",
      headers: { cookie: "__Host-quickducks_staff_refresh=valid.refresh.token" },
    }),
  ];

  for (const [index, request] of requests.entries()) {
    const response = await staffLogoutResponse(request, env, revokeFetch);
    assert.equal(response.status, index === 0 ? 405 : 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(response.headers.get("content-disposition"), null);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal(revokeCalls, 0);
});
