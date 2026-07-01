ALTER TABLE "question_papers" ADD COLUMN IF NOT EXISTS "published_at" TIMESTAMPTZ(6);
ALTER TABLE "question_papers" ADD COLUMN IF NOT EXISTS "parent_paper_id" UUID;
CREATE INDEX IF NOT EXISTS "question_papers_parent_paper_id_idx" ON "question_papers"("parent_paper_id");
