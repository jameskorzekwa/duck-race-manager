-- NFC intake creates this private requirement only after the physical tag write
-- has been confirmed. Existing ducks are deliberately not backfilled: they were
-- created by workflows that did not promise a photograph.
-- `race_commands.id` is already globally unique, but SQLite requires an exact
-- unique parent key for the event-and-duck associations below.
CREATE UNIQUE INDEX race_commands_id_event_result_idx
  ON race_commands(id, event_id, result_id);
CREATE UNIQUE INDEX event_ducks_event_id_id_duck_idx
  ON event_ducks(event_id, id, duck_id);

CREATE TABLE duck_photos (
  duck_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  event_duck_id TEXT NOT NULL,
  owner_staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  provisioning_command_id TEXT NOT NULL UNIQUE REFERENCES race_commands(id) ON DELETE CASCADE,
  upload_command_id TEXT UNIQUE REFERENCES race_commands(id) ON DELETE CASCADE,
  request_fingerprint TEXT,
  content_type TEXT CHECK (content_type IS NULL OR content_type = 'image/jpeg'),
  byte_length INTEGER CHECK (byte_length IS NULL OR byte_length BETWEEN 4 AND 1000000),
  content_sha256 TEXT CHECK (content_sha256 IS NULL OR length(content_sha256) = 64),
  photo_bytes BLOB,
  required_at TEXT NOT NULL,
  captured_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (event_id, event_duck_id, duck_id)
    REFERENCES event_ducks(event_id, id, duck_id) ON DELETE CASCADE,
  FOREIGN KEY (provisioning_command_id, event_id, duck_id)
    REFERENCES race_commands(id, event_id, result_id) ON DELETE CASCADE,
  FOREIGN KEY (upload_command_id, event_id, duck_id)
    REFERENCES race_commands(id, event_id, result_id) ON DELETE CASCADE,
  CHECK (
    (upload_command_id IS NULL AND request_fingerprint IS NULL AND content_type IS NULL
      AND byte_length IS NULL AND content_sha256 IS NULL AND photo_bytes IS NULL
      AND captured_at IS NULL)
    OR
    (upload_command_id IS NOT NULL AND request_fingerprint IS NOT NULL AND content_type IS NOT NULL
      AND byte_length IS NOT NULL AND content_sha256 IS NOT NULL AND photo_bytes IS NOT NULL
      AND captured_at IS NOT NULL)
  ),
  CHECK (photo_bytes IS NULL OR length(photo_bytes) = byte_length)
);

CREATE INDEX duck_photos_event_idx ON duck_photos(event_id, captured_at);
