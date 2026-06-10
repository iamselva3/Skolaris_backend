-- AlterTable: add nullable branch scoping to exams, questions, uploads
ALTER TABLE "exams" ADD COLUMN "branch_id" UUID;
ALTER TABLE "questions" ADD COLUMN "branch_id" UUID;
ALTER TABLE "uploads" ADD COLUMN "branch_id" UUID;

-- CreateIndex
CREATE INDEX "exams_tenant_id_branch_id_idx" ON "exams"("tenant_id", "branch_id");
CREATE INDEX "questions_tenant_id_branch_id_idx" ON "questions"("tenant_id", "branch_id");
CREATE INDEX "uploads_tenant_id_branch_id_idx" ON "uploads"("tenant_id", "branch_id");

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "questions" ADD CONSTRAINT "questions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: each row inherits the branch of its creator (matches the create-path rule).
-- Rows whose creator has no branch (e.g. tenant-level super admins) stay NULL = tenant-wide.
UPDATE "exams" e
  SET "branch_id" = u."branch_id"
  FROM "users" u
  WHERE e."created_by" = u."id" AND e."branch_id" IS NULL;

UPDATE "questions" q
  SET "branch_id" = u."branch_id"
  FROM "users" u
  WHERE q."created_by" = u."id" AND q."branch_id" IS NULL;

UPDATE "uploads" up
  SET "branch_id" = u."branch_id"
  FROM "users" u
  WHERE up."uploaded_by" = u."id" AND up."branch_id" IS NULL;
