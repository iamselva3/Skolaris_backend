-- Visual Question type: the whole question is a single image; teacher marks one
-- positional option correct. Graded like SINGLE_CHOICE.
ALTER TYPE "QuestionType" ADD VALUE IF NOT EXISTS 'VISUAL';

-- Screenshot-first OCR: per-question crop metadata on the draft.
-- questionSnapshotKey already exists (the crop's R2 key). Add option count and
-- the source-page bounding box so the review UI and dedup/search can use them.
ALTER TABLE "ocr_drafts" ADD COLUMN "option_count" INTEGER;
ALTER TABLE "ocr_drafts" ADD COLUMN "source_coordinates" JSONB;
