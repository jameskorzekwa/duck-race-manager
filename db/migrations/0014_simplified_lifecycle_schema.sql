-- Rebuilds the schema around the simplified six-status race lifecycle.
--
-- PRs 2 and 3 removed every application path that reads or writes duck returns,
-- dispositions, purge claims, the RETURN_STEWARD role, and the retired
-- RETURN_PROCESSING/ARCHIVED statuses; the deployed Worker no longer touches
-- them. This migration removes them from the database as well.
--
-- The lifecycle is now DRAFT, REGISTRATION_OPEN, REGISTRATION_CLOSED,
-- ROUND_ONE, FINAL, COMPLETED, and administrator force delete is the only
-- cleanup path.
--
-- Destructive by explicit approval: every existing race dataset is wiped so the
-- rebuilt `events` CHECK cannot collide with a retired status and so no child
-- row blocks the table rebuild. Staff accounts, staff role assignments, staff
-- access/lifecycle command history, and the organization event defaults are
-- deliberately preserved.

-- ---------------------------------------------------------------------------
-- 1. Retire the triggers that depend on the tables and statuses being removed.
-- ---------------------------------------------------------------------------

-- `events_require_purge_claim` and `purging_events_are_read_only` (0011) exist
-- only for the ARCHIVED/PURGING flow. `heat_entries_delete_unlocked` (0009) is
-- rebuilt further down; it is dropped first so the wipe below can clear locked
-- rosters, and because its current definition escapes on ARCHIVED.
DROP TRIGGER events_require_purge_claim;
DROP TRIGGER purging_events_are_read_only;
DROP TRIGGER heat_entries_delete_unlocked;

-- ---------------------------------------------------------------------------
-- 2. Clear every event-scoped row, deepest child first.
-- ---------------------------------------------------------------------------

-- Every foreign key in this set is ON DELETE RESTRICT or CASCADE, so the order
-- is child-before-parent throughout. Staff tables are never touched.
DELETE FROM email_attempts;
DELETE FROM email_notifications;
DELETE FROM return_batch_items;
DELETE FROM return_batches;
DELETE FROM duck_event_dispositions;
DELETE FROM heat_result_history;
DELETE FROM heat_results;
DELETE FROM heat_entries;
DELETE FROM heats;
DELETE FROM duck_inventory_events;
DELETE FROM duck_assignments;
DELETE FROM event_ducks;
DELETE FROM browser_collection_registrations;
DELETE FROM browser_registration_collections;
DELETE FROM audit_events;
DELETE FROM race_entries;
DELETE FROM registrations;
-- `duck_tags.supersedes_tag_id` is a self-reference declared ON DELETE
-- RESTRICT, so a replacement chain (t1 <- t2 <- t3) would abort the delete when
-- it reaches a still-referenced parent. Clearing the column for every row first
-- drops all of those links at any chain depth and cannot violate
-- `CHECK (supersedes_tag_id IS NULL OR supersedes_tag_id != id)`.
UPDATE duck_tags SET supersedes_tag_id = NULL;
DELETE FROM duck_tags;
DELETE FROM ducks;
DELETE FROM event_purge_claims;
DELETE FROM race_commands;
DELETE FROM events;

-- ---------------------------------------------------------------------------
-- 3. Drop the retired tables and their indexes.
-- ---------------------------------------------------------------------------

DROP INDEX return_batch_items_active_duck_idx;
DROP INDEX return_batch_items_batch_sequence_idx;
DROP TABLE return_batch_items;

DROP INDEX return_batches_event_status_idx;
DROP TABLE return_batches;

DROP INDEX duck_event_dispositions_event_idx;
DROP TABLE duck_event_dispositions;

DROP TABLE event_purge_claims;

-- ---------------------------------------------------------------------------
-- 4. Rebuild `events` with the six remaining statuses.
-- ---------------------------------------------------------------------------

-- Documented SQLite table rebuild: create the replacement, copy, drop, rename,
-- recreate indexes. Section 2 left `events` empty and no inbound child rows, so
-- the drop and rename are safe with foreign keys enforced. Inbound foreign keys
-- in other tables name `events` textually, so they resolve to the rebuilt table
-- after the rename; `PRAGMA foreign_key_check` is expected to stay clean.
CREATE TABLE events_v14 (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(slug)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  event_date TEXT,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'DRAFT',
      'REGISTRATION_OPEN',
      'REGISTRATION_CLOSED',
      'ROUND_ONE',
      'FINAL',
      'COMPLETED'
    )
  ),
  registration_opens_at TEXT,
  registration_closes_at TEXT,
  email_required INTEGER NOT NULL DEFAULT 0 CHECK (email_required IN (0, 1)),
  heat_assignment_mode TEXT NOT NULL DEFAULT 'POST_CLOSE_BALANCED' CHECK (
    heat_assignment_mode IN ('IMMEDIATE_FIXED', 'POST_CLOSE_BALANCED')
  ),
  round_one_heat_capacity INTEGER NOT NULL DEFAULT 10 CHECK (round_one_heat_capacity > 0),
  final_heat_capacity INTEGER NOT NULL DEFAULT 50 CHECK (final_heat_capacity > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  public_name_policy TEXT NOT NULL DEFAULT 'FIRST_NAME_LAST_INITIAL' CHECK (
    public_name_policy IN ('FIRST_NAME_ONLY', 'FIRST_NAME_LAST_INITIAL', 'FULL_NAME')
  ),
  revision INTEGER NOT NULL DEFAULT 0,
  CHECK (
    registration_opens_at IS NULL
    OR registration_closes_at IS NULL
    OR registration_opens_at < registration_closes_at
  )
);

INSERT INTO events_v14
  (id, slug, name, event_date, timezone, status, registration_opens_at, registration_closes_at,
   email_required, heat_assignment_mode, round_one_heat_capacity, final_heat_capacity,
   created_at, updated_at, public_name_policy, revision)
SELECT id, slug, name, event_date, timezone, status, registration_opens_at, registration_closes_at,
       email_required, heat_assignment_mode, round_one_heat_capacity, final_heat_capacity,
       created_at, updated_at, public_name_policy, revision
  FROM events;

DROP TABLE events;
ALTER TABLE events_v14 RENAME TO events;

CREATE INDEX events_status_date_idx ON events(status, event_date);

-- ---------------------------------------------------------------------------
-- 5. Rebuild `heat_entries_delete_unlocked` without the ARCHIVED escape.
-- ---------------------------------------------------------------------------

-- Semantics are unchanged for normal operation: a roster is deletable only
-- while its heat is PLANNED and unlocked. The escape hatch force delete relies
-- on is no longer the retired ARCHIVED status but the FORCE_DELETE_EVENT
-- sentinel command row that force delete inserts as the first statement of its
-- batch, before any child delete runs.
CREATE TRIGGER heat_entries_delete_unlocked
BEFORE DELETE ON heat_entries
WHEN NOT EXISTS (
  SELECT 1 FROM heats h
   WHERE h.id = OLD.heat_id AND h.event_id = OLD.event_id
     AND (
       (h.status = 'PLANNED' AND h.roster_locked_at IS NULL)
       OR EXISTS (
         SELECT 1 FROM race_commands rc
          WHERE rc.event_id = h.event_id
            AND rc.command_type = 'FORCE_DELETE_EVENT'
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'heat roster is locked');
END;

-- ---------------------------------------------------------------------------
-- 6. Rebuild `staff_role_assignments` without RETURN_STEWARD.
-- ---------------------------------------------------------------------------

-- The retired role grants nothing in the deployed Worker, so removing the rows
-- changes no effective permission. They are deleted before the rebuild so the
-- copy cannot fail the new CHECK.
DELETE FROM staff_role_assignments WHERE role = 'RETURN_STEWARD';

CREATE TABLE staff_role_assignments_v14 (
  id TEXT PRIMARY KEY,
  staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN (
    'REGISTRATION',
    'DUCK_MANAGER',
    'ANNOUNCER',
    'HEAT_RUNNER',
    'RESULT_TAKER',
    'RACE_DIRECTOR'
  )),
  assigned_at TEXT NOT NULL,
  assigned_by_staff_profile_id TEXT REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  source_access_command_id TEXT REFERENCES staff_access_commands(id) ON DELETE RESTRICT,
  source_lifecycle_command_id TEXT REFERENCES staff_lifecycle_commands(id) ON DELETE RESTRICT,
  revoked_at TEXT,
  revoked_by_staff_profile_id TEXT REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  revocation_source_command_id TEXT REFERENCES staff_lifecycle_commands(id) ON DELETE RESTRICT,
  CHECK (
    (revoked_at IS NULL AND revoked_by_staff_profile_id IS NULL AND revocation_source_command_id IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_staff_profile_id IS NOT NULL AND revocation_source_command_id IS NOT NULL)
  ),
  CHECK (source_access_command_id IS NULL OR source_lifecycle_command_id IS NULL)
);

INSERT INTO staff_role_assignments_v14
  (id, staff_profile_id, role, assigned_at, assigned_by_staff_profile_id,
   source_access_command_id, source_lifecycle_command_id,
   revoked_at, revoked_by_staff_profile_id, revocation_source_command_id)
SELECT id, staff_profile_id, role, assigned_at, assigned_by_staff_profile_id,
       source_access_command_id, source_lifecycle_command_id,
       revoked_at, revoked_by_staff_profile_id, revocation_source_command_id
  FROM staff_role_assignments;

DROP TABLE staff_role_assignments;
ALTER TABLE staff_role_assignments_v14 RENAME TO staff_role_assignments;

CREATE UNIQUE INDEX staff_role_assignments_current_idx
  ON staff_role_assignments(staff_profile_id, role)
  WHERE revoked_at IS NULL;

CREATE INDEX staff_role_assignments_history_idx
  ON staff_role_assignments(staff_profile_id, assigned_at, revoked_at);

-- ---------------------------------------------------------------------------
-- 7. Scrub RETURN_STEWARD from historical role JSON.
-- ---------------------------------------------------------------------------

-- 0012 backfilled the then-current role vocabulary into both command tables, so
-- the retired value survives in replay projections unless it is removed here.
-- Element order and every other requested role are preserved; a command that
-- requested only RETURN_STEWARD becomes an empty list, which is exactly what
-- the deployed Worker already projects for it.
UPDATE staff_access_commands
   SET requested_roles_json = (
     SELECT json_group_array(value)
       FROM json_each(staff_access_commands.requested_roles_json)
      WHERE value <> 'RETURN_STEWARD'
   )
 WHERE requested_roles_json IS NOT NULL
   AND json_valid(requested_roles_json)
   AND json_type(requested_roles_json) = 'array'
   AND EXISTS (
     SELECT 1
       FROM json_each(staff_access_commands.requested_roles_json)
      WHERE value = 'RETURN_STEWARD'
   );

UPDATE staff_lifecycle_commands
   SET requested_roles_json = (
     SELECT json_group_array(value)
       FROM json_each(staff_lifecycle_commands.requested_roles_json)
      WHERE value <> 'RETURN_STEWARD'
   )
 WHERE requested_roles_json IS NOT NULL
   AND json_valid(requested_roles_json)
   AND json_type(requested_roles_json) = 'array'
   AND EXISTS (
     SELECT 1
       FROM json_each(staff_lifecycle_commands.requested_roles_json)
      WHERE value = 'RETURN_STEWARD'
   );
