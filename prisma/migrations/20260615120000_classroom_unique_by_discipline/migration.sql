-- A classroom's identity now includes its discipline (subject), so the same
-- batch/section name can exist under different disciplines (e.g. "Morning Batch / A"
-- under both NEET and JEE). Adding a column to the unique key is strictly more
-- permissive than before — no existing row can become a duplicate — so this is safe
-- to apply without data cleanup.
DROP INDEX "classrooms_tenant_id_branch_id_name_year_section_key";

CREATE UNIQUE INDEX "classrooms_tenant_id_branch_id_subject_name_year_section_key"
  ON "classrooms"("tenant_id", "branch_id", "subject", "name", "year", "section");
