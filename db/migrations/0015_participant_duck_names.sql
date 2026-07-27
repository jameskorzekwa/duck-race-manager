-- Optional participant-chosen name for one race entry's duck.
--
-- The name is written only by the browser that created the registration, and it
-- is projected back only to that browser's own My Ducks collection. It is
-- unmoderated free text for a public community event, so no public, board, or
-- staff surface reads this column: those keep the canonical "Duck #N".
--
-- Backward compatible with the previously deployed Worker: the column is
-- nullable with no default, and every existing insert into `race_entries` names
-- its columns explicitly, so an older Worker keeps writing rows that satisfy the
-- constraint below.
--
-- The CHECK is the authoritative bound. The Worker trims and collapses
-- whitespace before binding, so a stored value is already trimmed, non-empty,
-- and at most 40 characters; a blank-after-trim or oversized value is rejected
-- here even if a caller ever reached the write without validation.
ALTER TABLE race_entries
  ADD COLUMN duck_name TEXT
  CHECK (
    duck_name IS NULL
    OR (
      duck_name = trim(duck_name)
      AND length(duck_name) BETWEEN 1 AND 40
    )
  );
