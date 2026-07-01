-- Resumable OCR (P0) — checkpoint-based OCR so a backend crash/restart/timeout
-- resumes from the last completed page instead of restarting from page 1.
-- Purely additive: new nullable/defaulted columns on ocr_jobs + a new per-page
-- checkpoint table. No existing data is rewritten.

-- AlterTable: durable lifecycle + progress counters on the parent OCR job.
ALTER TABLE "ocr_jobs"
  ADD COLUMN "status" TEXT DEFAULT 'QUEUED',
  ADD COLUMN "total_pages" INTEGER,
  ADD COLUMN "last_completed_page" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex: recovery scans ocr_jobs by status.
CREATE INDEX "ocr_jobs_status_idx" ON "ocr_jobs"("status");

-- CreateTable: one row per successfully-OCR'd page (the resume checkpoint).
CREATE TABLE "ocr_page_checkpoints" (
    "id" UUID NOT NULL,
    "ocr_job_id" UUID NOT NULL,
    "page_number" INTEGER NOT NULL,
    "artifact" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ocr_page_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ocr_page_checkpoints_ocr_job_id_idx" ON "ocr_page_checkpoints"("ocr_job_id");

-- CreateIndex: one checkpoint per (job, page) — enables upsert-on-conflict.
CREATE UNIQUE INDEX "ocr_page_checkpoints_ocr_job_id_page_number_key" ON "ocr_page_checkpoints"("ocr_job_id", "page_number");

-- AddForeignKey: cascade-delete checkpoints with their parent job.
ALTER TABLE "ocr_page_checkpoints"
  ADD CONSTRAINT "ocr_page_checkpoints_ocr_job_id_fkey"
  FOREIGN KEY ("ocr_job_id") REFERENCES "ocr_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
