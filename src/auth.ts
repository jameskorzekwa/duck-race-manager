import { CognitoJwtVerifier } from "aws-jwt-verify";

import type { Env } from "./types.ts";

export interface StaffActor {
  id: string;
  cognitoSub: string;
  email: string;
  displayName: string | null;
  isSystemAdmin: boolean;
  authentication: "bearer" | "cookie";
}

export const staffSessionCookieName = "__Host-quickducks_staff";

interface VerifiedToken {
  sub: string;
}

type TokenVerifier = (token: string, env: Env) => Promise<VerifiedToken>;

const verifiers = new Map<string, ReturnType<typeof CognitoJwtVerifier.create>>();

const readCookie = (request: Request, name: string): string | null => {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const item of header.split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
};

const verifyCognitoAccessToken: TokenVerifier = async (token, env) => {
  const key = `${env.COGNITO_USER_POOL_ID}:${env.COGNITO_USER_POOL_CLIENT_ID}`;
  let verifier = verifiers.get(key);
  if (verifier === undefined) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: env.COGNITO_USER_POOL_ID,
      tokenUse: "access",
      clientId: env.COGNITO_USER_POOL_CLIENT_ID,
    });
    verifiers.set(key, verifier);
  }

  const payload = await verifier.verify(token);
  return { sub: payload.sub };
};

export const authenticateStaff = async (
  request: Request,
  env: Env,
  verifyToken: TokenVerifier = verifyCognitoAccessToken,
): Promise<StaffActor | null> => {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
  const cookieToken = readCookie(request, staffSessionCookieName);
  const token = match?.[1] ?? cookieToken;
  if (token === undefined || token === null || !/^[A-Za-z0-9._~-]+$/.test(token)) return null;
  const authentication = match === undefined || match === null ? "cookie" : "bearer";

  try {
    const payload = await verifyToken(token, env);
    const profile = await env.DB.prepare(
      `SELECT id, cognito_sub, email, display_name, is_system_admin
         FROM staff_profiles
        WHERE cognito_sub = ? AND is_active = 1`,
    ).bind(payload.sub).first<{
      id: string;
      cognito_sub: string;
      email: string;
      display_name: string | null;
      is_system_admin: number;
    }>();
    if (profile === null) return null;

    return {
      id: profile.id,
      cognitoSub: profile.cognito_sub,
      email: profile.email,
      displayName: profile.display_name,
      isSystemAdmin: profile.is_system_admin === 1,
      authentication,
    };
  } catch {
    return null;
  }
};
