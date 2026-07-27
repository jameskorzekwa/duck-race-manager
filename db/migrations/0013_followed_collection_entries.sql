-- Records how each browser-collection link was created.
--
-- 'REGISTRATION' means the registration was created in this browser, so the
-- browser legitimately already holds that registration's staff lookup code.
-- 'FOLLOWED' means the link was added from the public exact-name race status
-- search, which carries no lookup code and no private token. A followed link
-- must therefore never be projected with a lookup code.
--
-- Backward compatible with the previously deployed Worker: it inserts
-- (collection_id, registration_id, added_at) only, and those rows take the
-- 'REGISTRATION' default, which preserves today's shipped projection.
ALTER TABLE browser_collection_registrations
  ADD COLUMN added_via TEXT NOT NULL DEFAULT 'REGISTRATION'
  CHECK (added_via IN ('REGISTRATION', 'FOLLOWED'));
