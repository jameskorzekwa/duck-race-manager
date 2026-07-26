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

export const createCognitoStaffProvisioner = (
  clientForEnv: typeof client = client,
): StaffIdentityProvisioner => ({
  async create(email, displayName, env) {
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
    await clientForEnv(env).send(new AdminDisableUserCommand({
      UserPoolId: env.COGNITO_USER_POOL_ID,
      Username: username,
    }));
  },

  async enable(username, env) {
    await clientForEnv(env).send(new AdminEnableUserCommand({
      UserPoolId: env.COGNITO_USER_POOL_ID,
      Username: username,
    }));
  },

  async globalSignOut(username, env) {
    await clientForEnv(env).send(new AdminUserGlobalSignOutCommand({
      UserPoolId: env.COGNITO_USER_POOL_ID,
      Username: username,
    }));
  },
});

export const cognitoStaffLifecycle = createCognitoStaffLifecycle();
