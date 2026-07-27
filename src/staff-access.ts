import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";

import { isLocalPreviewOrigin } from "./local-preview.ts";
import type { Env } from "./types.ts";

export interface ProvisionedStaffIdentity {
  cognitoSub: string;
  username: string;
  created: boolean;
}

export interface StaffIdentityProvisioner {
  create(email: string, displayName: string, env: Env): Promise<ProvisionedStaffIdentity>;
  delete(username: string, env: Env): Promise<void>;
}

export interface StaffIdentityLifecycle {
  disable(username: string, env: Env): Promise<void>;
  enable(username: string, env: Env): Promise<void>;
  globalSignOut(username: string, env: Env): Promise<void>;
}

const client = (env: Env): CognitoIdentityProviderClient => new CognitoIdentityProviderClient({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
});

const attribute = (
  attributes: Array<{ Name?: string; Value?: string }> | undefined,
  name: string,
): string | null => attributes?.find((item) => item.Name === name)?.Value ?? null;

// A local preview has no AWS credentials and no route to Cognito, so the identity
// side of staff management is satisfied locally while every D1 write, guard, and
// audit row still runs for real. The subject is namespaced so a local identity can
// never collide with a Cognito subject. `isLocalPreviewOrigin` is false for every
// https origin, so a deployed Worker always talks to the real user pool.
const localStaffIdentity = (email: string): ProvisionedStaffIdentity => ({
  cognitoSub: `local-preview-${email}`,
  username: email,
  created: true,
});

export const createCognitoStaffProvisioner = (
  clientForEnv: typeof client = client,
): StaffIdentityProvisioner => ({
  async create(email, displayName, env) {
    if (isLocalPreviewOrigin(env.APP_ORIGIN)) return localStaffIdentity(email);
    const cognito = clientForEnv(env);
    try {
      const result = await cognito.send(new AdminCreateUserCommand({
        UserPoolId: env.COGNITO_USER_POOL_ID,
        Username: email,
        MessageAction: "SUPPRESS",
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
          { Name: "name", Value: displayName },
        ],
      }));
      const cognitoSub = attribute(result.User?.Attributes, "sub");
      if (cognitoSub === null || result.User?.Username === undefined) {
        throw new Error("Cognito did not return the new staff identity.");
      }
      return { cognitoSub, username: result.User.Username, created: true };
    } catch (error) {
      if (!(error instanceof UsernameExistsException) && (error as { name?: string }).name !== "UsernameExistsException") {
        throw error;
      }
    }

    const existing = await cognito.send(new AdminGetUserCommand({
      UserPoolId: env.COGNITO_USER_POOL_ID,
      Username: email,
    }));
    const cognitoSub = attribute(existing.UserAttributes, "sub");
    const cognitoEmail = attribute(existing.UserAttributes, "email");
    if (
      existing.Enabled !== true
      || cognitoSub === null
      || cognitoEmail?.toLowerCase() !== email
      || existing.Username === undefined
    ) {
      throw new Error("The existing Cognito identity cannot be authorized for this email.");
    }
    return { cognitoSub, username: existing.Username, created: false };
  },

  async delete(username, env) {
    if (isLocalPreviewOrigin(env.APP_ORIGIN)) return;
    await clientForEnv(env).send(new AdminDeleteUserCommand({
      UserPoolId: env.COGNITO_USER_POOL_ID,
      Username: username,
    }));
  },
});

export const cognitoStaffProvisioner = createCognitoStaffProvisioner();

export const createCognitoStaffLifecycle = (
  clientForEnv: typeof client = client,
): StaffIdentityLifecycle => ({
  async disable(username, env) {
    if (isLocalPreviewOrigin(env.APP_ORIGIN)) return;
    await clientForEnv(env).send(new AdminDisableUserCommand({
      UserPoolId: env.COGNITO_USER_POOL_ID,
      Username: username,
    }));
  },

  async enable(username, env) {
    if (isLocalPreviewOrigin(env.APP_ORIGIN)) return;
    await clientForEnv(env).send(new AdminEnableUserCommand({
      UserPoolId: env.COGNITO_USER_POOL_ID,
      Username: username,
    }));
  },

  async globalSignOut(username, env) {
    if (isLocalPreviewOrigin(env.APP_ORIGIN)) return;
    await clientForEnv(env).send(new AdminUserGlobalSignOutCommand({
      UserPoolId: env.COGNITO_USER_POOL_ID,
      Username: username,
    }));
  },
});

export const cognitoStaffLifecycle = createCognitoStaffLifecycle();
