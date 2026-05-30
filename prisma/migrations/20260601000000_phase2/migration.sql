-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'FILL_BLANK', 'TRUE_FALSE', 'MATCH_FOLLOWING', 'MATRIX_MATCH', 'DESCRIPTIVE');

-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('PENDING_UPLOAD', 'UPLOADED', 'PROCESSING', 'READY_FOR_REVIEW', 'APPROVED', 'FAILED');

-- CreateEnum
CREATE TYPE "OcrDraftStatus" AS ENUM ('PENDING_REVIEW', 'EDITED', 'APPROVED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL');

-- CreateTable
CREATE TABLE "students" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "branch_id" UUID,
    "class_label" TEXT,
    "roll_no" TEXT,
    "parent_contact" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classrooms" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "year" TEXT,
    "section" TEXT,
    "subject" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "classrooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classroom_students" (
    "classroom_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "classroom_students_pkey" PRIMARY KEY ("classroom_id","student_id")
);

-- CreateTable
CREATE TABLE "uploads" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "original_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT,
    "storage_key" TEXT NOT NULL,
    "status" "UploadStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ocr_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "upload_id" UUID NOT NULL,
    "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "overall_confidence" DECIMAL(4,3),
    "error_message" TEXT,
    "raw_output" JSONB,
    "provider_used" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ocr_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ocr_drafts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ocr_job_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "detected_type" "QuestionType",
    "options" JSONB,
    "confidence" DECIMAL(4,3),
    "status" "OcrDraftStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "approved_question_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ocr_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "source_upload_id" UUID,
    "type" "QuestionType" NOT NULL,
    "payload" JSONB NOT NULL,
    "subject" TEXT,
    "topic" TEXT,
    "difficulty" "Difficulty" NOT NULL DEFAULT 'MEDIUM',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_options" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "is_correct" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL,

    CONSTRAINT "question_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "students_user_id_key" ON "students"("user_id");

-- CreateIndex
CREATE INDEX "students_tenant_id_branch_id_idx" ON "students"("tenant_id", "branch_id");

-- CreateIndex
CREATE INDEX "classrooms_tenant_id_branch_id_idx" ON "classrooms"("tenant_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "classrooms_tenant_id_branch_id_name_key" ON "classrooms"("tenant_id", "branch_id", "name");

-- CreateIndex
CREATE INDEX "classroom_students_student_id_idx" ON "classroom_students"("student_id");

-- CreateIndex
CREATE INDEX "uploads_tenant_id_uploaded_by_idx" ON "uploads"("tenant_id", "uploaded_by");

-- CreateIndex
CREATE INDEX "uploads_tenant_id_status_idx" ON "uploads"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ocr_jobs_upload_id_key" ON "ocr_jobs"("upload_id");

-- CreateIndex
CREATE INDEX "ocr_jobs_tenant_id_upload_id_idx" ON "ocr_jobs"("tenant_id", "upload_id");

-- CreateIndex
CREATE UNIQUE INDEX "ocr_drafts_approved_question_id_key" ON "ocr_drafts"("approved_question_id");

-- CreateIndex
CREATE INDEX "ocr_drafts_tenant_id_ocr_job_id_idx" ON "ocr_drafts"("tenant_id", "ocr_job_id");

-- CreateIndex
CREATE INDEX "ocr_drafts_tenant_id_status_idx" ON "ocr_drafts"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "questions_tenant_id_subject_topic_idx" ON "questions"("tenant_id", "subject", "topic");

-- CreateIndex
CREATE INDEX "questions_tenant_id_type_idx" ON "questions"("tenant_id", "type");

-- CreateIndex
CREATE INDEX "questions_tenant_id_created_by_idx" ON "questions"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "question_options_tenant_id_question_id_idx" ON "question_options"("tenant_id", "question_id");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_recipient_user_id_read_at_idx" ON "notifications"("tenant_id", "recipient_user_id", "read_at");

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classroom_students" ADD CONSTRAINT "classroom_students_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classroom_students" ADD CONSTRAINT "classroom_students_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "uploads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocr_drafts" ADD CONSTRAINT "ocr_drafts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocr_drafts" ADD CONSTRAINT "ocr_drafts_ocr_job_id_fkey" FOREIGN KEY ("ocr_job_id") REFERENCES "ocr_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocr_drafts" ADD CONSTRAINT "ocr_drafts_approved_question_id_fkey" FOREIGN KEY ("approved_question_id") REFERENCES "questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_source_upload_id_fkey" FOREIGN KEY ("source_upload_id") REFERENCES "uploads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_options" ADD CONSTRAINT "question_options_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_options" ADD CONSTRAINT "question_options_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

