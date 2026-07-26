import { authenticateStaff, staffSessionCookieName, type StaffActor } from "./auth.ts";
import { randomToken } from "./registration.ts";
import type { Env } from "./types.ts";

const oauthCookieName = "__Host-quickducks_oauth";

interface OAuthFlow {
  state: string;
  verifier: string;
  returnTo: string;
}

interface CognitoTokenResponse {
  access_token?: string;
  expires_in?: number;
}

export type StaffLoginCompletion =
  | { ok: true; actor: StaffActor; accessToken: string; expiresIn: number; returnTo: string }
  | { ok: false; status: number; error: string };

const readCookie = (request: Request, name: string): string | null => {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const item of header.split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
};

const safeReturnTo = (value: string | null): string =>
  value !== null && value.startsWith("/") && !value.startsWith("//") && value.length <= 512
    ? value
    : "/staff";

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const pkceChallenge = async (verifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
};

const callbackUrl = (env: Env): string => new URL("/auth/callback", env.APP_ORIGIN).toString();

export const staffSessionCookie = (accessToken: string, expiresIn: number): string =>
  `${staffSessionCookieName}=${accessToken}; Path=/; Max-Age=${Math.max(60, Math.min(3_600, expiresIn))}; Secure; HttpOnly; SameSite=Lax`;

export const clearStaffSessionCookie = (): string =>
  `${staffSessionCookieName}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;

const clearOAuthCookie = (): string =>
  `${oauthCookieName}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;

export const startStaffLogin = async (request: Request, env: Env): Promise<Response> => {
  const requestUrl = new URL(request.url);
  const flow: OAuthFlow = {
    state: randomToken(24),
    verifier: randomToken(48),
    returnTo: safeReturnTo(requestUrl.searchParams.get("returnTo")),
  };
  const authorizationUrl = new URL("/oauth2/authorize", env.COGNITO_DOMAIN);
  authorizationUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: env.COGNITO_USER_POOL_CLIENT_ID,
    redirect_uri: callbackUrl(env),
    scope: "openid email profile",
    state: flow.state,
    code_challenge_method: "S256",
    code_challenge: await pkceChallenge(flow.verifier),
  }).toString();

  return new Response(null, {
    status: 302,
    headers: {
      "cache-control": "no-store",
      location: authorizationUrl.toString(),
      "set-cookie": `${oauthCookieName}=${encodeURIComponent(JSON.stringify(flow))}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax`,
    },
  });
};

export const completeStaffLogin = async (
  request: Request,
  env: Env,
  authenticate: typeof authenticateStaff = authenticateStaff,
  tokenFetch: typeof fetch = fetch,
): Promise<StaffLoginCompletion> => {
  const url = new URL(request.url);
  const encodedFlow = readCookie(request, oauthCookieName);
  if (encodedFlow === null) return { ok: false, status: 400, error: "The sign-in request expired. Start again." };

  let flow: OAuthFlow;
  try {
    flow = JSON.parse(decodeURIComponent(encodedFlow)) as OAuthFlow;
  } catch {
    return { ok: false, status: 400, error: "The sign-in request is invalid. Start again." };
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (
    typeof flow.state !== "string"
    || typeof flow.verifier !== "string"
    || typeof flow.returnTo !== "string"
    || state !== flow.state
    || code === null
    || code.length > 4_096
  ) {
    return { ok: false, status: 400, error: "Cognito could not verify this sign-in request. Start again." };
  }

  let tokenResponse: Response;
  try {
    tokenResponse = await tokenFetch(new URL("/oauth2/token", env.COGNITO_DOMAIN), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: env.COGNITO_USER_POOL_CLIENT_ID,
        code,
        redirect_uri: callbackUrl(env),
        code_verifier: flow.verifier,
      }),
    });
  } catch {
    return { ok: false, status: 502, error: "Cognito sign-in is temporarily unavailable." };
  }
  if (!tokenResponse.ok) return { ok: false, status: 401, error: "Cognito did not accept this sign-in request." };

  let tokens: CognitoTokenResponse;
  try {
    tokens = await tokenResponse.json<CognitoTokenResponse>();
  } catch {
    return { ok: false, status: 502, error: "Cognito returned an invalid staff session." };
  }
  if (typeof tokens.access_token !== "string" || !/^[A-Za-z0-9._~-]+$/.test(tokens.access_token)) {
    return { ok: false, status: 502, error: "Cognito returned an invalid staff session." };
  }
  const actor = await authenticate(new Request(env.APP_ORIGIN, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  }), env);
  if (actor === null) return { ok: false, status: 403, error: "This Cognito account is not authorized for QuickDucks staff access." };

  return {
    ok: true,
    actor,
    accessToken: tokens.access_token,
    expiresIn: typeof tokens.expires_in === "number" ? tokens.expires_in : 3_600,
    returnTo: safeReturnTo(flow.returnTo),
  };
};

export const finishStaffLoginResponse = (completion: Extract<StaffLoginCompletion, { ok: true }>): Response => {
  const headers = new Headers({
    "cache-control": "no-store",
    location: completion.returnTo,
  });
  headers.append("set-cookie", staffSessionCookie(completion.accessToken, completion.expiresIn));
  headers.append("set-cookie", clearOAuthCookie());
  return new Response(null, { status: 303, headers });
};

export const staffLogoutResponse = (env: Env): Response => {
  const logoutUrl = new URL("/logout", env.COGNITO_DOMAIN);
  logoutUrl.search = new URLSearchParams({
    client_id: env.COGNITO_USER_POOL_CLIENT_ID,
    logout_uri: env.APP_ORIGIN,
  }).toString();
  return new Response(null, {
    status: 303,
    headers: {
      "cache-control": "no-store",
      location: logoutUrl.toString(),
      "set-cookie": clearStaffSessionCookie(),
    },
  });
};

export const clearFailedOAuthCookie = clearOAuthCookie;
