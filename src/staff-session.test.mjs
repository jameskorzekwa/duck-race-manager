import assert from "node:assert/strict";
import test from "node:test";

import {
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

test("exchanges the Cognito code and creates a short-lived staff session", async () => {
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
      return Response.json({ access_token: "valid.jwt.token", expires_in: 900 });
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
  assert.match(sessionCookies, /__Host-quickducks_oauth=/);
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

test("clears the local session and redirects through Cognito logout", () => {
  const response = staffLogoutResponse(env);
  const location = new URL(response.headers.get("location"));

  assert.equal(response.status, 303);
  assert.equal(location.pathname, "/logout");
  assert.equal(location.searchParams.get("client_id"), env.COGNITO_USER_POOL_CLIENT_ID);
  assert.equal(location.searchParams.get("logout_uri"), env.APP_ORIGIN);
  assert.match(response.headers.get("set-cookie"), /__Host-quickducks_staff=;/);
});
