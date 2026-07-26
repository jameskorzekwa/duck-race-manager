ALTER TABLE registrations ADD COLUMN staff_notes TEXT CHECK (
  staff_notes IS NULL OR length(staff_notes) <= 2000
);
