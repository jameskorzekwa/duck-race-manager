import { CognitoJwtVerifier } from "aws-jwt-verify";

import type { Env } from "./types.ts";

export interface StaffActor {
  id: string;
  cognitoSub: string;
  email: string;
  displayName: string | null;
  isSystemAdmin: boolean;
}

interface VerifiedToken {
  sub: string;
}

type TokenVerifier = (token: string, env: Env) => Promise<VerifiedToken>;

const verifiers = new Map<string, ReturnType<typeof CognitoJwtVerifier.create>>();

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
  if (match === undefined || match === null) return null;

  try {
    const payload = await verifyToken(match[1], env);
    const profile = await env.DB.prepare(
      `SELECT id, cognito_sub, email, display_name, is_system_admin
         FROM staff_profiles
        WHERE cognito_sub = ?`,
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
    };
  } catch {
    return null;
  }
};
