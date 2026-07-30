-- Participant-specific proof for contact access and the SMS consent flag.
--
-- Both columns are additive and optional/defaulted so the previously deployed
-- Worker can continue to create registrations and collection links while this
-- migration is live. Existing REGISTRATION links intentionally start without a
-- proof: the new Worker can mint one from that retained ownership link. A
-- FOLLOWED link can never use that compatibility path.
ALTER TABLE browser_collection_registrations
  ADD COLUMN ownership_proof_hash TEXT
  CHECK (
    ownership_proof_hash IS NULL
    OR (
      length(ownership_proof_hash) = 64
      AND ownership_proof_hash NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE registrations
  ADD COLUMN sms_notifications_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (sms_notifications_enabled IN (0, 1));

CREATE TRIGGER followed_links_have_no_ownership_proof_insert
BEFORE INSERT ON browser_collection_registrations
WHEN NEW.added_via = 'FOLLOWED' AND NEW.ownership_proof_hash IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'followed links cannot hold ownership proof');
END;

CREATE TRIGGER followed_links_have_no_ownership_proof_update
BEFORE UPDATE OF added_via, ownership_proof_hash ON browser_collection_registrations
WHEN NEW.added_via = 'FOLLOWED' AND NEW.ownership_proof_hash IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'followed links cannot hold ownership proof');
END;

-- A proof may be retained for the same participant in more than one browser
-- collection (for example after an idempotent registration retry), but it must
-- never become a credential for a different participant. Triggers express that
-- participant-scoped uniqueness without preventing same-participant links.
CREATE TRIGGER ownership_proof_is_participant_specific_insert
BEFORE INSERT ON browser_collection_registrations
WHEN NEW.ownership_proof_hash IS NOT NULL
  AND EXISTS (
    SELECT 1
      FROM browser_collection_registrations existing
     WHERE existing.ownership_proof_hash = NEW.ownership_proof_hash
       AND existing.registration_id <> NEW.registration_id
  )
BEGIN
  SELECT RAISE(ABORT, 'ownership proof belongs to another participant');
END;

CREATE TRIGGER ownership_proof_is_participant_specific_update
BEFORE UPDATE OF registration_id, ownership_proof_hash ON browser_collection_registrations
WHEN NEW.ownership_proof_hash IS NOT NULL
  AND EXISTS (
    SELECT 1
      FROM browser_collection_registrations existing
     WHERE existing.ownership_proof_hash = NEW.ownership_proof_hash
       AND existing.registration_id <> NEW.registration_id
  )
BEGIN
  SELECT RAISE(ABORT, 'ownership proof belongs to another participant');
END;

-- Consent cannot remain enabled after its delivery address is cleared. These
-- triggers normalize rather than reject so a rolled-back Worker that does not
-- know the new SMS column can still clear a phone number safely.
CREATE TRIGGER registrations_sms_without_phone_is_disabled_insert
AFTER INSERT ON registrations
WHEN NEW.phone IS NULL AND NEW.sms_notifications_enabled = 1
BEGIN
  UPDATE registrations SET sms_notifications_enabled = 0 WHERE id = NEW.id;
END;

CREATE TRIGGER registrations_sms_without_phone_is_disabled_update
AFTER UPDATE OF phone, sms_notifications_enabled ON registrations
WHEN NEW.phone IS NULL AND NEW.sms_notifications_enabled = 1
BEGIN
  UPDATE registrations SET sms_notifications_enabled = 0 WHERE id = NEW.id;
END;
