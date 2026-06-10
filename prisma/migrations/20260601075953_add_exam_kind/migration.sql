-- CreateEnum
CREATE TYPE "ExamKind" AS ENUM ('PAPER', 'TEST');

-- AlterTable
ALTER TABLE "exams" ADD COLUMN     "kind" "ExamKind" NOT NULL DEFAULT 'TEST';

-- CreateIndex
CREATE INDEX "exams_tenant_id_kind_status_idx" ON "exams"("tenant_id", "kind", "status");
