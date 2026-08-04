-- Photos are required only for ducks confirmed by the new NFC intake Worker.
-- Existing ducks and confirmations performed by the previously deployed Worker
-- remain valid while this migration is applied before the Worker deployment.
CREATE TABLE duck_photos (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  duck_id TEXT NOT NULL UNIQUE REFERENCES ducks(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'READY')),
  object_key TEXT UNIQUE,
  upload_command_id TEXT UNIQUE,
  content_sha256 TEXT CHECK (content_sha256 IS NULL OR length(content_sha256) = 64),
  byte_length INTEGER CHECK (byte_length IS NULL OR byte_length BETWEEN 4 AND 1500000),
  owner_staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  ready_at TEXT,
  CHECK (
    (state = 'PENDING' AND object_key IS NULL AND upload_command_id IS NULL
      AND content_sha256 IS NULL AND byte_length IS NULL AND ready_at IS NULL)
    OR
    (state = 'READY' AND object_key IS NOT NULL AND upload_command_id IS NOT NULL
      AND content_sha256 IS NOT NULL AND byte_length IS NOT NULL AND ready_at IS NOT NULL)
  )
);

CREATE INDEX duck_photos_event_state_idx ON duck_photos(event_id, state, created_at);

-- R2 cannot participate in a D1 transaction. This FK-free cleanup ledger is
-- populated by the same transaction that makes a photo inaccessible and
-- survives deletion of the duck, event, command history, and audit history.
CREATE TABLE duck_photo_cleanup (
  object_key TEXT PRIMARY KEY,
  queued_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at TEXT
);

CREATE TRIGGER duck_photos_queue_object_cleanup
AFTER DELETE ON duck_photos
WHEN OLD.object_key IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO duck_photo_cleanup (object_key, queued_at)
  VALUES (OLD.object_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
