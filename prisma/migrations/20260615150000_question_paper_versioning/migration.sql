-- Question Paper versioning / immutability support.
-- `published_at`: set once when a paper is first published; the permanent record
-- of when a version went live (never cleared/overwritten).
-- `parent_paper_id`: provenance for a revision working copy created by editing a
-- published paper (points back at the original; plain scalar, no FK cascade).

-- AlterTable
ALTER TABLE "question_papers" ADD COLUMN "published_at" TIMESTAMPTZ(6);
ALTER TABLE "question_papers" ADD COLUMN "parent_paper_id" UUID;

-- CreateIndex
CREATE INDEX "question_papers_parent_paper_id_idx" ON "question_papers"("parent_paper_id");
