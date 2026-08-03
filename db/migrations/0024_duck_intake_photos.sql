-- NFC provisioning creates one private, required photo slot for the duck it
-- just reserved. Existing ducks are deliberately not backfilled: they predate
-- the requirement and render the legacy no-photo placeholder.
CREATE TABLE duck_photos (
  duck_id TEXT PRIMARY KEY REFERENCES ducks(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_duck_id TEXT NOT NULL UNIQUE,
  required_by_staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'READY')),
  upload_command_id TEXT UNIQUE,
  object_key TEXT UNIQUE,
  content_sha256 TEXT,
  byte_length INTEGER,
  created_at TEXT NOT NULL,
  uploaded_at TEXT,
  FOREIGN KEY (event_id, event_duck_id, duck_id)
    REFERENCES event_ducks(event_id, id, duck_id) ON DELETE CASCADE,
  FOREIGN KEY (event_id, upload_command_id)
    REFERENCES race_commands(event_id, id) ON DELETE RESTRICT,
  CHECK (
    (status = 'PENDING'
      AND upload_command_id IS NULL AND object_key IS NULL
      AND content_sha256 IS NULL AND byte_length IS NULL AND uploaded_at IS NULL)
    OR
    (status = 'READY'
      AND upload_command_id IS NOT NULL AND object_key IS NOT NULL
      AND length(content_sha256) = 64
      AND byte_length BETWEEN 4 AND 1572864
      AND uploaded_at IS NOT NULL)
  )
);

CREATE INDEX duck_photos_event_status_idx ON duck_photos(event_id, status);
CREATE INDEX duck_photos_required_by_idx
  ON duck_photos(required_by_staff_profile_id, event_id, status);
