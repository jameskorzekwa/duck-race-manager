import assert from "node:assert/strict";
import test from "node:test";

import {
  createCognitoStaffLifecycle,
  createCognitoStaffProvisioner,
} from "./staff-access.ts";

const env = {
  AWS_ACCESS_KEY_ID: "test-access-key",
  AWS_REGION: "us-east-1",
  AWS_SECRET_ACCESS_KEY: "test-secret-key",
  COGNITO_USER_POOL_ID: "us-east-1_example",
};

test("provisions a confirmed passwordless Cognito email without a temporary password", async () => {
  const commands = [];
  const provisioner = createCognitoStaffProvisioner(() => ({
    async send(command) {
      commands.push(command);
      return {
        User: {
          Username: "cognito-user",
          Attributes: [
            { Name: "sub", Value: "new-sub" },
            { Name: "email", Value: "staff@example.com" },
          ],
        },
      };
    },
  }));
  const result = await provisioner.create("staff@example.com", "Staff Person", env);
  const input = commands[0].input;

  assert.deepEqual(result, { cognitoSub: "new-sub", username: "cognito-user", created: true });
  assert.equal(commands[0].constructor.name, "AdminCreateUserCommand");
  assert.equal(input.UserPoolId, env.COGNITO_USER_POOL_ID);
  assert.equal(input.Username, "staff@example.com");
  assert.equal(input.MessageAction, "SUPPRESS");
  assert.equal("TemporaryPassword" in input, false);
  assert.deepEqual(input.UserAttributes, [
    { Name: "email", Value: "staff@example.com" },
    { Name: "email_verified", Value: "true" },
    { Name: "name", Value: "Staff Person" },
  ]);
});

test("reuses an enabled matching Cognito identity after an interrupted grant", async () => {
  const commands = [];
  const provisioner = createCognitoStaffProvisioner(() => ({
    async send(command) {
      commands.push(command);
      if (commands.length === 1) throw Object.assign(new Error("exists"), { name: "UsernameExistsException" });
      return {
        Enabled: true,
        Username: "existing-user",
        UserAttributes: [
          { Name: "sub", Value: "existing-sub" },
          { Name: "email", Value: "staff@example.com" },
        ],
      };
    },
  }));

  assert.deepEqual(
    await provisioner.create("staff@example.com", "Staff Person", env),
    { cognitoSub: "existing-sub", username: "existing-user", created: false },
  );
  assert.deepEqual(commands.map((command) => command.constructor.name), [
    "AdminCreateUserCommand",
    "AdminGetUserCommand",
  ]);
});

test("deletes a newly created Cognito identity during compensation", async () => {
  const commands = [];
  const provisioner = createCognitoStaffProvisioner(() => ({
    async send(command) {
      commands.push(command);
      return {};
    },
  }));

  await provisioner.delete("cognito-user", env);
  assert.equal(commands[0].constructor.name, "AdminDeleteUserCommand");
  assert.deepEqual(commands[0].input, {
    UserPoolId: env.COGNITO_USER_POOL_ID,
    Username: "cognito-user",
  });
});

test("disables, enables, and globally signs out the selected Cognito identity", async () => {
  const commands = [];
  const lifecycle = createCognitoStaffLifecycle(() => ({
    async send(command) {
      commands.push(command);
      return {};
    },
  }));

  await lifecycle.disable("staff@example.com", env);
  await lifecycle.globalSignOut("staff@example.com", env);
  await lifecycle.enable("staff@example.com", env);

  assert.deepEqual(commands.map((command) => command.constructor.name), [
    "AdminDisableUserCommand",
    "AdminUserGlobalSignOutCommand",
    "AdminEnableUserCommand",
  ]);
  for (const command of commands) {
    assert.deepEqual(command.input, {
      UserPoolId: env.COGNITO_USER_POOL_ID,
      Username: "staff@example.com",
    });
  }
});
