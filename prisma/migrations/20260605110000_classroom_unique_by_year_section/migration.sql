-- A classroom is unique by name + year + section within a branch (not name
-- alone), so the same class/year can have multiple sections (A, B, C, …).
DROP INDEX "classrooms_tenant_id_branch_id_name_key";

CREATE UNIQUE INDEX "classrooms_tenant_id_branch_id_name_year_section_key"
  ON "classrooms"("tenant_id", "branch_id", "name", "year", "section");
