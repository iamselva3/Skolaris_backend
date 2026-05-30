-- CreateEnum
CREATE TYPE "ExamStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'LIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'GRADED', 'FLAGGED');

-- CreateEnum
CREATE TYPE "ViolationType" AS ENUM ('TAB_SWITCH', 'FULLSCREEN_EXIT', 'COPY_ATTEMPT', 'PASTE_ATTEMPT', 'RIGHT_CLICK', 'WINDOW_BLUR', 'DEVTOOLS_OPEN', 'NETWORK_DROP');

-- CreateEnum
CREATE TYPE "TestMode" AS ENUM ('ONLINE', 'OFFLINE_PRINT');

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "error_message" TEXT,
ADD COLUMN     "failed_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "exams" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "duration_seconds" INTEGER NOT NULL,
    "total_marks" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "default_negative_marks" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "randomize_questions" BOOLEAN NOT NULL DEFAULT false,
    "randomize_options" BOOLEAN NOT NULL DEFAULT false,
    "status" "ExamStatus" NOT NULL DEFAULT 'DRAFT',
    "opens_at" TIMESTAMPTZ(6),
    "closes_at" TIMESTAMPTZ(6),
    "test_mode" "TestMode" NOT NULL DEFAULT 'ONLINE',
    "published_at" TIMESTAMPTZ(6),
    "anti_cheat_config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "exams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_sections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "time_limit_seconds" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "exam_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_questions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "section_id" UUID,
    "question_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "marks" DECIMAL(5,2) NOT NULL,
    "negative_marks" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "exam_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_assignments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "classroom_id" UUID,
    "student_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_attempts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "started_at" TIMESTAMPTZ(6),
    "submitted_at" TIMESTAMPTZ(6),
    "graded_at" TIMESTAMPTZ(6),
    "time_remaining_seconds" INTEGER,
    "score" DECIMAL(8,2),
    "auto_submitted" BOOLEAN NOT NULL DEFAULT false,
    "question_order_seed" BIGINT NOT NULL,
    "violation_count" INTEGER NOT NULL DEFAULT 0,
    "descriptive_pending" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "exam_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attempt_answers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "exam_question_id" UUID NOT NULL,
    "answer_payload" JSONB,
    "is_correct" BOOLEAN,
    "marks_awarded" DECIMAL(5,2),
    "time_spent_seconds" INTEGER NOT NULL DEFAULT 0,
    "is_flagged_by_student" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "attempt_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "violations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "type" "ViolationType" NOT NULL,
    "detail" JSONB,
    "client_timestamp" TIMESTAMPTZ(6) NOT NULL,
    "server_timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "violations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_stats" (
    "question_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "total_attempts" INTEGER NOT NULL DEFAULT 0,
    "correct_attempts" INTEGER NOT NULL DEFAULT 0,
    "avg_time_seconds" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "difficulty_score" DECIMAL(4,3),
    "last_recomputed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "question_stats_pkey" PRIMARY KEY ("question_id")
);

-- CreateTable
CREATE TABLE "topic_reports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "attempts_count" INTEGER NOT NULL DEFAULT 0,
    "correct_count" INTEGER NOT NULL DEFAULT 0,
    "score_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "is_weak" BOOLEAN NOT NULL DEFAULT false,
    "last_recomputed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "topic_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exams_tenant_id_status_idx" ON "exams"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "exams_tenant_id_created_by_idx" ON "exams"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "exam_sections_tenant_id_exam_id_idx" ON "exam_sections"("tenant_id", "exam_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_sections_exam_id_position_key" ON "exam_sections"("exam_id", "position");

-- CreateIndex
CREATE INDEX "exam_questions_tenant_id_exam_id_position_idx" ON "exam_questions"("tenant_id", "exam_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "exam_questions_exam_id_question_id_key" ON "exam_questions"("exam_id", "question_id");

-- CreateIndex
CREATE INDEX "exam_assignments_tenant_id_exam_id_idx" ON "exam_assignments"("tenant_id", "exam_id");

-- CreateIndex
CREATE INDEX "exam_attempts_tenant_id_student_id_status_idx" ON "exam_attempts"("tenant_id", "student_id", "status");

-- CreateIndex
CREATE INDEX "exam_attempts_tenant_id_exam_id_status_idx" ON "exam_attempts"("tenant_id", "exam_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "exam_attempts_exam_id_student_id_key" ON "exam_attempts"("exam_id", "student_id");

-- CreateIndex
CREATE INDEX "attempt_answers_tenant_id_attempt_id_idx" ON "attempt_answers"("tenant_id", "attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "attempt_answers_attempt_id_exam_question_id_key" ON "attempt_answers"("attempt_id", "exam_question_id");

-- CreateIndex
CREATE INDEX "violations_tenant_id_attempt_id_server_timestamp_idx" ON "violations"("tenant_id", "attempt_id", "server_timestamp");

-- CreateIndex
CREATE INDEX "question_stats_tenant_id_idx" ON "question_stats"("tenant_id");

-- CreateIndex
CREATE INDEX "topic_reports_tenant_id_student_id_is_weak_idx" ON "topic_reports"("tenant_id", "student_id", "is_weak");

-- CreateIndex
CREATE UNIQUE INDEX "topic_reports_student_id_subject_topic_key" ON "topic_reports"("student_id", "subject", "topic");

-- CreateIndex
CREATE INDEX "notifications_channel_sent_at_failed_at_idx" ON "notifications"("channel", "sent_at", "failed_at");

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_sections" ADD CONSTRAINT "exam_sections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_sections" ADD CONSTRAINT "exam_sections_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_questions" ADD CONSTRAINT "exam_questions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_questions" ADD CONSTRAINT "exam_questions_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_questions" ADD CONSTRAINT "exam_questions_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "exam_sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_questions" ADD CONSTRAINT "exam_questions_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_assignments" ADD CONSTRAINT "exam_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_assignments" ADD CONSTRAINT "exam_assignments_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_assignments" ADD CONSTRAINT "exam_assignments_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_assignments" ADD CONSTRAINT "exam_assignments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_attempts" ADD CONSTRAINT "exam_attempts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_attempts" ADD CONSTRAINT "exam_attempts_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_attempts" ADD CONSTRAINT "exam_attempts_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "exam_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_exam_question_id_fkey" FOREIGN KEY ("exam_question_id") REFERENCES "exam_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "violations" ADD CONSTRAINT "violations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "violations" ADD CONSTRAINT "violations_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "exam_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_stats" ADD CONSTRAINT "question_stats_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_stats" ADD CONSTRAINT "question_stats_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_reports" ADD CONSTRAINT "topic_reports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_reports" ADD CONSTRAINT "topic_reports_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

