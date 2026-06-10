-- Answer-key import: pre-filled correct answer mapped from an uploaded/typed
-- answer key, so teachers review exceptions instead of hand-picking every answer.
ALTER TABLE "ocr_drafts" ADD COLUMN "suggested_answer" JSONB;
