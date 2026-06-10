-- Standalone Question Paper module (decoupled from Exam).

-- CreateEnum
CREATE TYPE "QuestionPaperStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "question_papers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "created_by" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "program_id" UUID,
    "subject_id" UUID,
    "duration_seconds" INTEGER NOT NULL,
    "default_negative_marks" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "total_marks" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "status" "QuestionPaperStatus" NOT NULL DEFAULT 'DRAFT',
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "question_papers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_paper_questions" (
    "id" UUID NOT NULL,
    "paper_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "marks" DECIMAL(6,2) NOT NULL DEFAULT 1,
    "negative_marks" DECIMAL(5,2) NOT NULL DEFAULT 0,
    CONSTRAINT "question_paper_questions_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "exams" ADD COLUMN "source_paper_id" UUID;

-- CreateIndex
CREATE INDEX "question_papers_tenant_id_branch_id_idx" ON "question_papers"("tenant_id", "branch_id");
CREATE INDEX "question_papers_tenant_id_status_idx" ON "question_papers"("tenant_id", "status");
CREATE INDEX "question_papers_tenant_id_created_by_idx" ON "question_papers"("tenant_id", "created_by");
CREATE UNIQUE INDEX "question_paper_questions_paper_id_question_id_key" ON "question_paper_questions"("paper_id", "question_id");
CREATE INDEX "question_paper_questions_paper_id_idx" ON "question_paper_questions"("paper_id");
CREATE INDEX "exams_source_paper_id_idx" ON "exams"("source_paper_id");

-- AddForeignKey
ALTER TABLE "question_papers" ADD CONSTRAINT "question_papers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "question_paper_questions" ADD CONSTRAINT "question_paper_questions_paper_id_fkey" FOREIGN KEY ("paper_id") REFERENCES "question_papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "question_paper_questions" ADD CONSTRAINT "question_paper_questions_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "exams" ADD CONSTRAINT "exams_source_paper_id_fkey" FOREIGN KEY ("source_paper_id") REFERENCES "question_papers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
