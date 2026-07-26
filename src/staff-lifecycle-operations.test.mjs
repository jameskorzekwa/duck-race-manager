import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { authenticateStaff } from "./auth.ts";
import { handleStaffLifecycleOperations } from "./staff-lifecycle-operations.ts";

const actor = {
  id: "admin_actor",
  cognitoSub: "admin-actor-sub",
  email: "admin.actor@example.com",
  displayName: "Admin Actor",
  isSystemAdmin: true,
  roles: [],
  authentication: "bearer",
};

const profile = {
  id: "staff_target",
  email: "staff.target@example.com",
  display_name: "Staff Target",
  is_system_admin: 0,
  is_active: 1,
  role_revision: 0,
  roles_csv: "REGISTRATION",
  created_at: "2026-07-25T00:00:00.000Z",
};

const makeDb = (first = () => null, all = () => ({ results: [] })) => {
  const statements = [];
  const batches = [];
  return {
    statements,
    batches,
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) {
          this.args = args;
          return this;
        },
        async first() {
          return first(sql, this.args);
        },
        async all() {
          return all(sql, this.args);
        },
      };
      statements.push(statement);
      return statement;
    },
    async batch(items) {
      batches.push(items);
      return items.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
};

const makeEnv = (DB) => ({
  APP_ORIGIN: "https://quickducks.com",
  AWS_ACCESS_KEY_ID: "test-access-key",
  AWS_REGION: "us-east-1",
  AWS_SECRET_ACCESS_KEY: "test-secret-key",
  COGNITO_USER_POOL_ID: "us-east-1_example",
  COGNITO_USER_POOL_CLIENT_ID: "client-example",
  DB,
});

const request = (path, body, method = "POST") => new Request(`https://quickducks.com${path}`, {
  method,
  headers: body === undefined ? undefined : { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const identity = (calls, failures = {}) => ({
  async disable(username) {
    calls.push(["disable", username]);
    if (failures.disable) throw new Error("disable failed");
  },
  async enable(username) {
    calls.push(["enable", username]);
    if (failures.enable) throw new Error("enable failed");
  },
  async globalSignOut(username) {
    calls.push(["globalSignOut", username]);
    if (failures.globalSignOut) throw new Error("sign-out failed");
  },
});

const commandId = "2c293c36-bca9-4bd0-bc12-a5c9d1ab8370";

test("returns null for routes outside staff lifecycle operations", async () => {
  const response = await handleStaffLifecycleOperations(
    request("/api/v1/staff/events", undefined, "GET"),
    makeEnv(makeDb()),
    actor,
  );
  assert.equal(response, null);
});

test("regular staff cannot list, change roles, deactivate, or reactivate staff", async () => {
  const regularStaff = { ...actor, isSystemAdmin: false, roles: ["RACE_DIRECTOR"] };
  const db = makeDb();
  const calls = [];
  const routes = [
    request("/api/v1/staff/profiles", undefined, "GET"),
    request(`/api/v1/staff/profiles/${profile.id}/role`, { commandId, role: "ADMIN", roles: [], revision: 0 }),
    request(`/api/v1/staff/profiles/${profile.id}/deactivate`, { commandId }),
    request(`/api/v1/staff/profiles/${profile.id}/reactivate`, { commandId }),
  ];

  for (const lifecycleRequest of routes) {
    const response = await handleStaffLifecycleOperations(
      lifecycleRequest,
      makeEnv(db),
      regularStaff,
      identity(calls),
    );
    assert.equal(response.status, 403);
  }
  assert.equal(db.statements.length, 0);
  assert.deepEqual(calls, []);
});

test("administrator list responses preserve existing fields and add active state", async () => {
  const db = makeDb(
    () => null,
    () => ({ results: [profile, { ...profile, id: "inactive", is_active: 0 }] }),
  );
  const response = await handleStaffLifecycleOperations(
    request("/api/v1/staff/profiles", undefined, "GET"),
    makeEnv(db),
    actor,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.staff[0], {
    id: profile.id,
    email: profile.email,
    displayName: profile.display_name,
    role: "STAFF",
    roles: ["REGISTRATION"],
    roleRevision: 0,
    createdAt: profile.created_at,
    active: true,
  });
  assert.equal(body.staff[1].active, false);
  assert.match(db.statements[0].sql, /is_active/);
});

test("an administrator changes a role with an idempotency record and retained audit", async () => {
  let targetReads = 0;
  const db = makeDb((sql) => {
    if (!sql.includes("WHERE p.id = ?") || !sql.includes("FROM staff_profiles")) return null;
    targetReads += 1;
    return targetReads === 1
      ? profile
      : { ...profile, is_system_admin: 1, role_revision: 1, roles_csv: "" };
  });
  const response = await handleStaffLifecycleOperations(
    request(`/api/v1/staff/profiles/${profile.id}/role`, { commandId, role: "ADMIN", roles: [], revision: 0 }),
    makeEnv(db),
    actor,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.staff.role, "ADMIN");
  assert.equal(body.staff.active, true);
  assert.equal(body.replayed, false);
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /UPDATE staff_profiles/);
  assert.match(sql, /INSERT INTO staff_lifecycle_commands/);
  assert.match(sql, /INSERT INTO staff_lifecycle_audit_events/);
  const audit = db.batches[0].find((statement) => statement.sql.includes("staff_lifecycle_audit_events"));
  assert.match(audit.sql, /STAFF_ROLE_CHANGED/);
  assert.deepEqual(JSON.parse(audit.args[5]), {
    previousRole: "STAFF",
    previousRoles: ["REGISTRATION"],
    role: "ADMIN",
    roles: [],
    previousRevision: 0,
    revision: 1,
  });
});

test("command replay returns the stored result without another Cognito call or audit", async () => {
  const replay = {
    command_type: "DEACTIVATE_STAFF",
    target_staff_profile_id: profile.id,
    requested_role: null,
    requested_roles_json: null,
    expected_role_revision: null,
    result_role_revision: null,
    result_is_system_admin: 0,
    result_is_active: 0,
    id: profile.id,
    email: profile.email,
    display_name: profile.display_name,
    role_revision: profile.role_revision,
    roles_csv: profile.roles_csv,
    created_at: profile.created_at,
  };
  const db = makeDb((sql) => sql.includes("FROM staff_lifecycle_commands c") ? replay : null);
  const calls = [];
  const response = await handleStaffLifecycleOperations(
    request(`/api/v1/staff/profiles/${profile.id}/deactivate`, { commandId }),
    makeEnv(db),
    actor,
    identity(calls),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.replayed, true);
  assert.equal(body.staff.active, false);
  assert.deepEqual(calls, []);
  assert.equal(db.batches.length, 0);
});

test("the final active administrator cannot be demoted or deactivated", async () => {
  const finalAdmin = { ...profile, id: "final_admin", is_system_admin: 1, roles_csv: "" };
  const db = makeDb((sql) => {
    if (sql.includes("FROM staff_lifecycle_commands c")) return null;
    if (sql.includes("WHERE p.id = ?") && sql.includes("FROM staff_profiles")) return finalAdmin;
    if (sql.includes("WHERE id != ?")) return null;
    return null;
  });
  const calls = [];

  const demote = await handleStaffLifecycleOperations(
    request(`/api/v1/staff/profiles/${finalAdmin.id}/role`, {
      commandId, role: "STAFF", roles: ["RACE_DIRECTOR"], revision: 0,
    }),
    makeEnv(db),
    actor,
    identity(calls),
  );
  const deactivate = await handleStaffLifecycleOperations(
    request(`/api/v1/staff/profiles/${finalAdmin.id}/deactivate`, {
      commandId: "4bf42b78-ad41-4a60-83fb-dfbfe72fff2e",
    }),
    makeEnv(db),
    actor,
    identity(calls),
  );

  assert.equal(demote.status, 409);
  assert.match((await demote.json()).error, /final active administrator/);
  assert.equal(deactivate.status, 409);
  assert.match((await deactivate.json()).error, /final active administrator/);
  assert.deepEqual(calls, []);
  assert.equal(db.batches.length, 0);
});

test("administrators cannot demote or deactivate themselves", async () => {
  const ownProfile = {
    ...profile,
    id: actor.id,
    email: actor.email,
    is_system_admin: 1,
    roles_csv: "",
  };
  const db = makeDb((sql) => sql.includes("WHERE p.id = ?") && sql.includes("FROM staff_profiles")
    ? ownProfile
    : null);

  const demote = await handleStaffLifecycleOperations(
    request(`/api/v1/staff/profiles/${actor.id}/role`, {
      commandId, role: "STAFF", roles: ["RACE_DIRECTOR"], revision: 0,
    }),
    makeEnv(db),
    actor,
  );
  const deactivate = await handleStaffLifecycleOperations(
    request(`/api/v1/staff/profiles/${actor.id}/deactivate`, {
      commandId: "4bf42b78-ad41-4a60-83fb-dfbfe72fff2e",
    }),
    makeEnv(db),
    actor,
  );

  assert.equal(demote.status, 409);
  assert.match((await demote.json()).error, /own account/);
  assert.equal(deactivate.status, 409);
  assert.match((await deactivate.json()).error, /own account/);
  assert.equal(db.batches.length, 0);
});

test("deactivation disables Cognito, signs out sessions, and then saves inactive state", async () => {
  let targetReads = 0;
  const db = makeDb((sql) => {
    if (!sql.includes("WHERE p.id = ?") || !sql.includes("FROM staff_profiles")) return null;
    targetReads += 1;
    return targetReads === 1 ? profile : { ...profile, is_active: 0 };
  });
  const calls = [];
  const response = await handleStaffLifecycleOperations(
    request(`/api/v1/staff/profiles/${profile.id}/deactivate`, { commandId }),
    makeEnv(db),
    actor,
    identity(calls),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.staff.active, false);
  assert.deepEqual(calls, [
    ["disable", profile.email],
    ["globalSignOut", profile.email],
  ]);
  const update = db.batches[0].find((statement) => statement.sql.includes("UPDATE staff_profiles"));
  assert.equal(update.args[0], 0);
  assert.doesNotMatch(update.sql, /is_system_admin/);
});

test("a failed global sign-out re-enables Cognito and saves no lifecycle state", async () => {
  const db = makeDb((sql) => sql.includes("WHERE p.id = ?") && sql.includes("FROM staff_profiles")
    ? profile
    : null);
  const calls = [];
  const lifecycle = identity(calls);
  lifecycle.globalSignOut = async (username) => {
    calls.push(["globalSignOut", username]);
    throw new Error("sign-out failed");
  };
  const response = await handleStaffLifecycleOperations(
    request(`/api/v1/staff/profiles/${profile.id}/deactivate`, { commandId }),
    makeEnv(db),
    actor,
    lifecycle,
  );

  assert.equal(response.status, 502);
  assert.deepEqual(calls, [
    ["disable", profile.email],
    ["globalSignOut", profile.email],
    ["enable", profile.email],
  ]);
  assert.equal(db.batches.length, 0);
});

test("a failed D1 deactivation compensates by re-enabling Cognito", async () => {
  const db = makeDb((sql) => sql.includes("WHERE p.id = ?") && sql.includes("FROM staff_profiles")
    ? profile
    : null);
  db.batch = async () => {
    throw new Error("D1 conflict");
  };
  const calls = [];
  const response = await handleStaffLifecycleOperations(
    request(`/api/v1/staff/profiles/${profile.id}/deactivate`, { commandId }),
    makeEnv(db),
    actor,
    identity(calls),
  );

  assert.equal(response.status, 409);
  assert.deepEqual(calls, [
    ["disable", profile.email],
    ["globalSignOut", profile.email],
    ["enable", profile.email],
  ]);
});

test("a failed D1 reactivation compensates by disabling Cognito", async () => {
  const inactive = { ...profile, is_active: 0 };
  const db = makeDb((sql) => sql.includes("WHERE p.id = ?") && sql.includes("FROM staff_profiles")
    ? inactive
    : null);
  db.batch = async () => {
    throw new Error("D1 conflict");
  };
  const calls = [];
  const response = await handleStaffLifecycleOperations(
    request(`/api/v1/staff/profiles/${profile.id}/reactivate`, { commandId }),
    makeEnv(db),
    actor,
    identity(calls),
  );

  assert.equal(response.status, 409);
  assert.deepEqual(calls, [
    ["enable", profile.email],
    ["disable", profile.email],
  ]);
});

test("a Cognito enable failure leaves inactive D1 state untouched", async () => {
  const inactive = { ...profile, is_active: 0 };
  const db = makeDb((sql) => sql.includes("WHERE p.id = ?") && sql.includes("FROM staff_profiles")
    ? inactive
    : null);
  const calls = [];
  const response = await handleStaffLifecycleOperations(
    request(`/api/v1/staff/profiles/${profile.id}/reactivate`, { commandId }),
    makeEnv(db),
    actor,
    identity(calls, { enable: true }),
  );

  assert.equal(response.status, 502);
  assert.deepEqual(calls, [["enable", profile.email]]);
  assert.equal(db.batches.length, 0);
});

const createLifecycleDatabase = () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of [
    "0001_staff_identity.sql",
    "0005_staff_access_management.sql",
    "0010_staff_lifecycle.sql",
    "0012_staff_role_assignments.sql",
  ]) {
    database.exec(readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), "utf8"));
  }
  return database;
};

const sqliteD1 = (database, beforeBatch) => ({
  prepare(sql) {
    return {
      sql,
      args: [],
      bind(...args) {
        this.args = args;
        return this;
      },
      async first() {
        return database.prepare(sql).get(...this.args) ?? null;
      },
      async all() {
        return { results: database.prepare(sql).all(...this.args) };
      },
    };
  },
  async batch(statements) {
    beforeBatch();
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

test("role replacement rejects a revision changed between its pre-read and guarded batch", async (context) => {
  const database = createLifecycleDatabase();
  context.after(() => database.close());
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email, display_name, is_system_admin)
    VALUES
      ('${actor.id}', '${actor.cognitoSub}', '${actor.email}', '${actor.displayName}', 1),
      ('${profile.id}', 'target-sub', '${profile.email}', '${profile.display_name}', 0);
    INSERT INTO staff_role_assignments (id, staff_profile_id, role, assigned_at)
    VALUES ('target-registration', '${profile.id}', 'REGISTRATION', '2026-07-25T00:00:00Z');
  `);
  let batchCalls = 0;
  const DB = sqliteD1(database, () => {
    batchCalls += 1;
    database.exec(`
      UPDATE staff_profiles SET role_revision = 1 WHERE id = '${profile.id}';
      INSERT INTO staff_role_assignments (id, staff_profile_id, role, assigned_at)
      VALUES ('concurrent-duck-manager', '${profile.id}', 'DUCK_MANAGER', '2026-07-25T00:01:00Z');
    `);
  });

  const response = await handleStaffLifecycleOperations(
    request(`/api/v1/staff/profiles/${profile.id}/role`, {
      commandId, role: "ADMIN", roles: [], revision: 0,
    }),
    makeEnv(DB),
    actor,
  );
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.match(body.error, /conflicted with another update/);
  assert.equal(batchCalls, 1);
  assert.deepEqual(
    { ...database.prepare("SELECT is_system_admin, role_revision FROM staff_profiles WHERE id = ?").get(profile.id) },
    { is_system_admin: 0, role_revision: 1 },
  );
  assert.deepEqual(
    database.prepare(
      "SELECT role FROM staff_role_assignments WHERE staff_profile_id = ? AND revoked_at IS NULL ORDER BY role",
    ).all(profile.id).map((row) => ({ ...row })),
    [{ role: "DUCK_MANAGER" }, { role: "REGISTRATION" }],
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_lifecycle_commands").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_lifecycle_audit_events").get().count, 0);
});

test("the migration enforces a final-active-administrator invariant", () => {
  const database = createLifecycleDatabase();
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email, is_system_admin)
    VALUES ('admin-one', 'admin-one-sub', 'admin.one@example.com', 1);
  `);

  assert.throws(
    () => database.exec("UPDATE staff_profiles SET is_active = 0 WHERE id = 'admin-one'"),
    /at least one active system administrator is required/,
  );
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email, is_system_admin)
    VALUES ('admin-two', 'admin-two-sub', 'admin.two@example.com', 1);
    UPDATE staff_profiles SET is_active = 0 WHERE id = 'admin-one';
  `);
  assert.equal(database.prepare("SELECT is_active FROM staff_profiles WHERE id = 'admin-one'").get().is_active, 0);
  database.close();
});

test("lifecycle commands and security audits retain actor and target profiles", () => {
  const database = createLifecycleDatabase();
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email, is_system_admin)
    VALUES
      ('admin', 'admin-sub', 'admin@example.com', 1),
      ('staff', 'staff-sub', 'staff@example.com', 0);
    INSERT INTO staff_lifecycle_commands
      (id, command_type, target_staff_profile_id, requested_by_staff_profile_id,
       requested_role, result_is_system_admin, result_is_active, requested_at, completed_at)
    VALUES
      ('command', 'CHANGE_STAFF_ROLE', 'staff', 'admin', 'ADMIN', 1, 1,
       '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z');
    INSERT INTO staff_lifecycle_audit_events
      (id, command_id, actor_staff_profile_id, target_staff_profile_id, action, occurred_at)
    VALUES
      ('audit', 'command', 'admin', 'staff', 'STAFF_ROLE_CHANGED', '2026-07-25T00:00:00Z');
  `);

  assert.throws(() => database.exec("DELETE FROM staff_lifecycle_commands WHERE id = 'command'"), /FOREIGN KEY/);
  assert.throws(() => database.exec("DELETE FROM staff_profiles WHERE id = 'staff'"), /FOREIGN KEY/);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_lifecycle_audit_events").get().count, 1);
  database.close();
});

test("authentication rejects a valid Cognito token for an inactive staff profile", async () => {
  const database = createLifecycleDatabase();
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email, is_system_admin)
    VALUES ('admin', 'admin-sub', 'admin@example.com', 1);
    INSERT INTO staff_profiles (id, cognito_sub, email, is_active)
    VALUES ('inactive', 'inactive-sub', 'inactive@example.com', 0);
  `);
  const DB = {
    prepare(sql) {
      const statement = database.prepare(sql);
      let args = [];
      return {
        bind(...values) {
          args = values;
          return this;
        },
        async first() {
          return statement.get(...args) ?? null;
        },
      };
    },
  };
  const result = await authenticateStaff(
    new Request("https://quickducks.com/api/v1/staff/profiles", {
      headers: { authorization: "Bearer valid.jwt.token" },
    }),
    makeEnv(DB),
    async () => ({ sub: "inactive-sub" }),
  );

  assert.equal(result, null);
  database.close();
});
