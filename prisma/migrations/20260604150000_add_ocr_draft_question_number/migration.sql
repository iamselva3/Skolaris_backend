-- Segmentation: persist the detected question number + invalid-crop flag so the
-- Question Navigator can show a reliable count and missing/merged/invalid status.
ALTER TABLE "ocr_drafts" ADD COLUMN "question_number" INTEGER;
ALTER TABLE "ocr_drafts" ADD COLUMN "invalid_crop" BOOLEAN;
