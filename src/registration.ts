import type { Env } from "./types.ts";

export interface RegistrationInput {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  emailNotificationsEnabled: boolean;
}

export interface RegistrationValidation {
  value?: RegistrationInput;
  errors: Record<string, string>;
}

export interface ContactPreferencesInput {
  email: string | null;
  phone: string | null;
  emailNotificationsEnabled: boolean;
  smsNotificationsEnabled: boolean;
}

export interface ContactPreferencesValidation {
  value?: ContactPreferencesInput;
  errors: Record<string, string>;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const tokenAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const cleanName = (value: string | File | null): string =>
  typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";

const cleanOptional = (value: string | File | null): string | null => {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned === "" ? null : cleaned;
};

export const validateContactPreferences = (
  input: ContactPreferencesInput,
  emailRequired: boolean,
): ContactPreferencesValidation => {
  const email = input.email?.trim().toLowerCase() || null;
  const phone = input.phone?.trim() || null;
  const errors: Record<string, string> = {};

  if (emailRequired && email === null) errors.email = "Email is required for this race.";
  if (email !== null && (email.length > 254 || !emailPattern.test(email))) {
    errors.email = "Enter a valid email address.";
  }
  if (phone !== null && phone.length > 32) errors.phone = "Use 32 characters or fewer.";
  if (input.emailNotificationsEnabled && email === null) {
    errors.emailNotificationsEnabled = "Add an email address before choosing email updates.";
  }
  if (input.smsNotificationsEnabled && phone === null) {
    errors.smsNotificationsEnabled = "Add a phone number before choosing SMS updates.";
  }

  return Object.keys(errors).length > 0 ? { errors } : {
    errors,
    value: {
      email,
      phone,
      emailNotificationsEnabled: input.emailNotificationsEnabled,
      smsNotificationsEnabled: input.smsNotificationsEnabled,
    },
  };
};

export const validateRegistration = (
  form: FormData,
  emailRequired: boolean,
): RegistrationValidation => {
  const firstName = cleanName(form.get("first_name"));
  const lastName = cleanName(form.get("last_name"));
  const email = cleanOptional(form.get("email"))?.toLowerCase() ?? null;
  const phone = cleanOptional(form.get("phone"));
  const errors: Record<string, string> = {};

  if (firstName.length === 0) errors.first_name = "Enter a first name.";
  if (firstName.length > 80) errors.first_name = "Use 80 characters or fewer.";
  if (lastName.length === 0) errors.last_name = "Enter a last name.";
  if (lastName.length > 80) errors.last_name = "Use 80 characters or fewer.";

  if (emailRequired && email === null) errors.email = "Email is required for this race.";
  if (email !== null && (email.length > 254 || !emailPattern.test(email))) {
    errors.email = "Enter a valid email address.";
  }

  if (phone !== null && phone.length > 32) errors.phone = "Use 32 characters or fewer.";

  if (Object.keys(errors).length > 0) return { errors };

  return {
    errors,
    value: {
      firstName,
      lastName,
      email,
      phone,
      emailNotificationsEnabled: email !== null && form.get("email_notifications_enabled") === "on",
    },
  };
};

// A participant-chosen duck name is free text for a public community event, so
// it is bounded tightly and normalized once, here, for the API, the browser
// client, and the schema CHECK that repeats the same bound.
export const DUCK_NAME_MAX_LENGTH = 40;

// Returns the value that may be stored, or null when the input is blank after
// trimming, longer than the limit, or carries characters that could hide or
// reorder text on someone else's screen.
export const cleanDuckName = (value: string): string | null => {
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (cleaned.length === 0 || cleaned.length > DUCK_NAME_MAX_LENGTH) return null;
  return /[\p{Cc}\p{Cf}]/u.test(cleaned) ? null : cleaned;
};

export const randomToken = (byteLength = 32): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

export const randomLookupCode = (length = 8): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => tokenAlphabet[byte % tokenAlphabet.length]).join("");
};

export const hashToken = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const isPrivateToken = (value: string): boolean => /^[A-Za-z0-9_-]{43,128}$/.test(value);

export const isCommandId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

// Registration identifiers are generated with `crypto.randomUUID`, so a caller
// supplied one is accepted only in canonical RFC 4122 form.
export const isRegistrationId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

// Deletion is allowed for the same five post-draft statuses every other public
// surface uses, and for exactly one reason: it is only ever permitted for a
// registration with no duck and no heat place, so the row it removes never
// entered the race and can never have affected a published heat or result. A
// DRAFT event has no registrations to delete, and force delete event remains
// the only path that touches raced data.
export const DELETABLE_EVENT_STATUSES = [
  "REGISTRATION_OPEN",
  "REGISTRATION_CLOSED",
  "ROUND_ONE",
  "FINAL",
  "COMPLETED",
] as const;

const deletableEventStatusSql =
  `e.status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL', 'COMPLETED')`;

// `duck_assignments` and `heat_entries` are the two ON DELETE RESTRICT children
// of `race_entries`, and they are exactly the race-integrity rows a delete must
// never tear down. Any assignment counts, including an ended one, because an
// ended row still restricts the parent delete and still means this entry was
// paired — and pairing is what put a physical duck into a sealed heat bag.
// `heat_entries` additionally carries the roster-lock trigger, which this path
// can never reach: a race entry with any heat row is refused outright, so no
// locked roster is ever touched and no heat is ever renumbered.
//
// The consequence is the product rule: unpaired participants are deleted, paired
// participants are withdrawn or disqualified instead and their duck stays in the
// bag. This predicate is the single place that decides which of the two a given
// registration is eligible for.
const unpairedRaceEntrySql = `NOT EXISTS (
             SELECT 1 FROM duck_assignments da WHERE da.race_entry_id = re.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM heat_entries he WHERE he.race_entry_id = re.id
           )`;

// The single removable-registration predicate. Both the public projection and
// both delete paths build on it so the button, the preflight error, and the
// guarded write can never disagree.
export const removableRegistrationSql = `${deletableEventStatusSql}
           AND ${unpairedRaceEntrySql}`;

// The authoritative gate is the guarded `race_commands` insert each caller runs
// as the first statement of its batch: it materializes only when ownership,
// event status, and unpaired state all still hold. Every delete below is
// conditional on that row existing, so a refused attempt writes nothing at all
// even though D1 batches do not abort on a zero-row statement.
const deleteCommandGuard = `EXISTS (
         SELECT 1 FROM race_commands rc
          WHERE rc.id = ?
            AND rc.command_type = 'DELETE_REGISTRATION'
            AND rc.result_id = ?
       )`;

// Every foreign key that references `registrations` or its `race_entries` row
// is handled explicitly, deepest child first, rather than left to cascade
// order:
//
//   registrations       <- race_entries (RESTRICT)
//                       <- browser_collection_registrations (CASCADE)
//                       <- email_notifications (CASCADE)
//   race_entries        <- duck_assignments (RESTRICT, refused above)
//                       <- heat_entries (RESTRICT, refused above)
//   email_notifications <- email_attempts (CASCADE)
//
// Collection links are removed for every browser, not only the deleting one,
// because the registration itself is gone and a follower must not keep a
// dangling entry. The `race_commands` and `audit_events` rows deliberately
// survive: neither has a foreign key to `registrations`, and the audit trail of
// the deletion has to outlive its subject.
export const registrationDeletionStatements = (
  env: Env,
  commandId: string,
  registrationId: string,
): D1PreparedStatement[] => [
  env.DB.prepare(
    `DELETE FROM email_attempts
       WHERE notification_id IN (
         SELECT id FROM email_notifications WHERE registration_id = ?
       )
         AND ${deleteCommandGuard}`,
  ).bind(registrationId, commandId, registrationId),
  env.DB.prepare(
    `DELETE FROM email_notifications
       WHERE registration_id = ? AND ${deleteCommandGuard}`,
  ).bind(registrationId, commandId, registrationId),
  env.DB.prepare(
    `DELETE FROM browser_collection_registrations
       WHERE registration_id = ? AND ${deleteCommandGuard}`,
  ).bind(registrationId, commandId, registrationId),
  env.DB.prepare(
    `DELETE FROM race_entries
       WHERE registration_id = ? AND ${deleteCommandGuard}`,
  ).bind(registrationId, commandId, registrationId),
  env.DB.prepare(
    `DELETE FROM registrations
       WHERE id = ? AND ${deleteCommandGuard}`,
  ).bind(registrationId, commandId, registrationId),
];

// A committed deletion is proved by its command row rather than by batch change
// counts, so replay, refusal, and success are decided the same way on every
// adapter.
export const registrationDeletionCommitted = async (
  env: Env,
  commandId: string,
  registrationId: string,
): Promise<boolean> => await env.DB.prepare(
  `SELECT 1 AS committed
     FROM race_commands
    WHERE id = ? AND command_type = 'DELETE_REGISTRATION' AND result_id = ?
    LIMIT 1`,
).bind(commandId, registrationId).first<{ committed: number }>() !== null;

export const registrationDeletionAuditStatement = (
  env: Env,
  commandId: string,
  registrationId: string,
  actorType: "PUBLIC" | "STAFF",
  occurredAt: string,
  details: Record<string, unknown>,
): D1PreparedStatement => env.DB.prepare(
  `INSERT INTO audit_events
     (id, event_id, command_id, action, subject_type, subject_id,
      actor_type, occurred_at, details_json)
   SELECT ?, rc.event_id, rc.id, 'REGISTRATION_DELETED', 'REGISTRATION', rc.result_id, ?, ?, ?
     FROM race_commands rc
    WHERE rc.id = ?
      AND rc.command_type = 'DELETE_REGISTRATION'
      AND rc.result_id = ?`,
).bind(
  crypto.randomUUID(),
  actorType,
  occurredAt,
  JSON.stringify(details),
  commandId,
  registrationId,
);
