-- Replace the flat Course catalogue with a proper coaching-centre hierarchy:
--   Program → Subject → Topic → Chapter, plus TeacherSubject assignment.
-- Adds program/subject/topic/chapter FK columns to questions, exams, uploads.

-- Drop the old courses tables (dev-only data; no production rows yet).
DROP TABLE IF EXISTS "teacher_courses";
DROP TABLE IF EXISTS "courses";

-- CreateTable: programs
CREATE TABLE "programs" (
    "id"         UUID NOT NULL,
    "tenant_id"  UUID NOT NULL,
    "code"       TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "is_active"  BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "programs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "programs_tenant_id_code_key" ON "programs"("tenant_id", "code");
CREATE INDEX "programs_tenant_id_is_active_idx" ON "programs"("tenant_id", "is_active");
ALTER TABLE "programs" ADD CONSTRAINT "programs_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: subjects
CREATE TABLE "subjects" (
    "id"         UUID NOT NULL,
    "tenant_id"  UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "name"       TEXT NOT NULL,
    "is_active"  BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "subjects_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "subjects_tenant_id_program_id_name_key" ON "subjects"("tenant_id", "program_id", "name");
CREATE INDEX "subjects_tenant_id_program_id_idx" ON "subjects"("tenant_id", "program_id");
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_program_id_fkey"
    FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: topics
CREATE TABLE "topics" (
    "id"         UUID NOT NULL,
    "tenant_id"  UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "name"       TEXT NOT NULL,
    "position"   INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "topics_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "topics_tenant_id_subject_id_name_key" ON "topics"("tenant_id", "subject_id", "name");
CREATE INDEX "topics_tenant_id_subject_id_idx" ON "topics"("tenant_id", "subject_id");
ALTER TABLE "topics" ADD CONSTRAINT "topics_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "topics" ADD CONSTRAINT "topics_subject_id_fkey"
    FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: chapters
CREATE TABLE "chapters" (
    "id"         UUID NOT NULL,
    "tenant_id"  UUID NOT NULL,
    "topic_id"   UUID NOT NULL,
    "name"       TEXT NOT NULL,
    "position"   INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "chapters_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "chapters_tenant_id_topic_id_name_key" ON "chapters"("tenant_id", "topic_id", "name");
CREATE INDEX "chapters_tenant_id_topic_id_idx" ON "chapters"("tenant_id", "topic_id");
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_topic_id_fkey"
    FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: teacher_subjects
CREATE TABLE "teacher_subjects" (
    "user_id"    UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "joined_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "teacher_subjects_pkey" PRIMARY KEY ("user_id", "subject_id")
);
CREATE INDEX "teacher_subjects_subject_id_idx" ON "teacher_subjects"("subject_id");
ALTER TABLE "teacher_subjects" ADD CONSTRAINT "teacher_subjects_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "teacher_subjects" ADD CONSTRAINT "teacher_subjects_subject_id_fkey"
    FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add taxonomy FK columns to questions
ALTER TABLE "questions"
    ADD COLUMN "program_id" UUID,
    ADD COLUMN "subject_id" UUID,
    ADD COLUMN "topic_id"   UUID,
    ADD COLUMN "chapter_id" UUID;
CREATE INDEX "questions_tenant_id_program_id_subject_id_idx" ON "questions"("tenant_id", "program_id", "subject_id");
CREATE INDEX "questions_tenant_id_chapter_id_idx" ON "questions"("tenant_id", "chapter_id");
ALTER TABLE "questions" ADD CONSTRAINT "questions_program_id_fkey"
    FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "questions" ADD CONSTRAINT "questions_subject_id_fkey"
    FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "questions" ADD CONSTRAINT "questions_topic_id_fkey"
    FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "questions" ADD CONSTRAINT "questions_chapter_id_fkey"
    FOREIGN KEY ("chapter_id") REFERENCES "chapters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add taxonomy FK columns to exams
ALTER TABLE "exams"
    ADD COLUMN "program_id" UUID,
    ADD COLUMN "subject_id" UUID;
CREATE INDEX "exams_tenant_id_program_id_subject_id_idx" ON "exams"("tenant_id", "program_id", "subject_id");
ALTER TABLE "exams" ADD CONSTRAINT "exams_program_id_fkey"
    FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "exams" ADD CONSTRAINT "exams_subject_id_fkey"
    FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add taxonomy FK columns to uploads
ALTER TABLE "uploads"
    ADD COLUMN "program_id" UUID,
    ADD COLUMN "subject_id" UUID;
CREATE INDEX "uploads_tenant_id_program_id_subject_id_idx" ON "uploads"("tenant_id", "program_id", "subject_id");
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_program_id_fkey"
    FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_subject_id_fkey"
    FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
