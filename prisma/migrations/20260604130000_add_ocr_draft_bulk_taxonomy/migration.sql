-- Bulk taxonomy: Program/Subject/Chapter/Topic + difficulty assigned once across
-- an OCR batch ("apply to all/selected"), inherited by the approve flow as
-- review-time defaults. Denormalized (no FK) — values are validated at approve.
ALTER TABLE "ocr_drafts" ADD COLUMN "assigned_program_id" UUID;
ALTER TABLE "ocr_drafts" ADD COLUMN "assigned_subject_id" UUID;
ALTER TABLE "ocr_drafts" ADD COLUMN "assigned_topic_id" UUID;
ALTER TABLE "ocr_drafts" ADD COLUMN "assigned_chapter_id" UUID;
ALTER TABLE "ocr_drafts" ADD COLUMN "assigned_difficulty" "Difficulty";
