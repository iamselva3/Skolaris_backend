-- Per-program default marking (super-admin "Manage Marks" page). Newly created
-- questions seed their marks / negative marks from the selected program.
-- Defaults match the historical hard-coded QUESTION_DEFAULTS (4 marks / 1 negative).
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "default_marks" DOUBLE PRECISION NOT NULL DEFAULT 4;
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "default_negative_marks" DOUBLE PRECISION NOT NULL DEFAULT 1;
