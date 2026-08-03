-- NFC provisioning requires one private inventory photo before that station may
-- advance to another duck. Existing and manually-created ducks deliberately have
-- no row: the requirement begins only when the photo-aware Worker confirms a
-- newly written NFC tag.
-- SQLite requires the parent columns of the composite association below to be
-- covered by one unique key, even though command IDs are already globally
-- unique on their own.
CREATE UNIQUE INDEX race_commands_event_id_id_idx
  ON race_commands(event_id, id);

CREATE TABLE duck_photos (
  duck_id TEXT PRIMARY KEY REFERENCES ducks(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  provisioning_command_id TEXT NOT NULL UNIQUE,
  owner_staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  object_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'MISSING' CHECK (status IN ('MISSING', 'UPLOADING', 'STORED')),
  upload_command_id TEXT UNIQUE,
  content_sha256 TEXT,
  byte_size INTEGER,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stored_at TEXT,
  FOREIGN KEY (event_id, provisioning_command_id)
    REFERENCES race_commands(event_id, id) ON DELETE CASCADE,
  CHECK (
    (status = 'MISSING' AND object_key IS NULL
      AND upload_command_id IS NULL AND content_sha256 IS NULL
      AND byte_size IS NULL AND width IS NULL AND height IS NULL AND stored_at IS NULL)
    OR
    (status = 'UPLOADING' AND object_key IS NOT NULL
      AND upload_command_id IS NOT NULL AND content_sha256 IS NOT NULL
      AND length(content_sha256) = 64
      AND byte_size IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL
      AND byte_size BETWEEN 1 AND 3145728
      AND width BETWEEN 1 AND 1600 AND height BETWEEN 1 AND 1600
      AND width * height <= 2560000 AND stored_at IS NULL)
    OR
    (status = 'STORED' AND object_key IS NOT NULL
      AND upload_command_id IS NOT NULL AND content_sha256 IS NOT NULL
      AND length(content_sha256) = 64
      AND byte_size IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL
      AND byte_size BETWEEN 1 AND 3145728
      AND width BETWEEN 1 AND 1600 AND height BETWEEN 1 AND 1600
      AND width * height <= 2560000 AND stored_at IS NOT NULL)
  )
);

CREATE INDEX duck_photos_event_status_idx
  ON duck_photos(event_id, status, created_at);
CREATE INDEX duck_photos_owner_status_idx
  ON duck_photos(owner_staff_profile_id, event_id, status, created_at);
CREATE UNIQUE INDEX duck_photos_owner_incomplete_idx
  ON duck_photos(owner_staff_profile_id, event_id)
  WHERE status != 'STORED';

-- R2 deletion cannot participate in a D1 transaction. This event-independent
-- outbox survives a duck or whole-event cascade, immediately removes the
-- authenticated association, and lets the Worker retry private-object cleanup.
CREATE TABLE duck_photo_cleanup_jobs (
  object_key TEXT PRIMARY KEY,
  requested_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at TEXT
);

CREATE TRIGGER duck_photos_queue_object_cleanup
AFTER DELETE ON duck_photos
WHEN OLD.status IN ('UPLOADING', 'STORED')
BEGIN
  INSERT OR IGNORE INTO duck_photo_cleanup_jobs (object_key, requested_at)
  VALUES (
    OLD.object_key,
    strftime(
      '%Y-%m-%dT%H:%M:%fZ',
      'now',
      CASE WHEN OLD.status = 'UPLOADING' THEN '+5 minutes' ELSE '+0 minutes' END
    )
  );
END;
