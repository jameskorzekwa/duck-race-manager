import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const booleanFlag = (value, name) => {
  if (value === 0 || value === false) return false;
  if (value === 1 || value === true) return true;
  throw new Error(`D1 preflight returned an invalid ${name} flag.`);
};

export const checkD1RolePreflight = (payload) => {
  if (!Array.isArray(payload) || payload.length !== 1 || payload[0]?.success !== true) {
    throw new Error("D1 preflight did not return one successful query result.");
  }
  const rows = payload[0].results;
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("D1 preflight did not return exactly one result row.");
  }

  const roleTableExists = booleanFlag(rows[0].role_table_exists, "role_table_exists");
  const activeNonAdminExists = booleanFlag(rows[0].active_non_admin_exists, "active_non_admin_exists");
  const unmappedActiveNonAdminExists = booleanFlag(
    rows[0].unmapped_active_non_admin_exists,
    "unmapped_active_non_admin_exists",
  );
  if (unmappedActiveNonAdminExists) {
    throw new Error(
      "An active non-admin profile has no active role assignment; add an explicit reviewed role-mapping migration before release.",
    );
  }
  return { roleTableExists, activeNonAdminExists, unmappedActiveNonAdminExists };
};

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const result = checkD1RolePreflight(payload);
  const state = result.roleTableExists
    ? "all active non-admin profiles have an active role assignment"
    : "no active legacy non-admin profiles require mapping";
  process.stdout.write(`D1 role migration preflight passed: ${state}.\n`);
}
