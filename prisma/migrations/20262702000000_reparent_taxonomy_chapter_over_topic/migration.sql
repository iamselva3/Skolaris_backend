-- Re-parent taxonomy: Program → Subject → Chapter → Topic
-- (was Program → Subject → Topic → Chapter).
--
-- Chapter becomes the mid-level (child of Subject); Topic becomes the leaf
-- (child of Chapter). Also adds questions.chapter, a denormalized mid-level
-- name for future chapter-level reporting (TopicReport stays keyed on the leaf
-- `topic`).
--
-- The product is pre-launch with resettable taxonomy data. The new parent FK
-- columns are NOT NULL and cannot be backfilled from the inverted hierarchy, so
-- existing taxonomy rows are cleared here and rebuilt by `prisma db seed`.
-- Consumer taxonomy references (questions, ocr_drafts) are nulled first.

-- 0. Clear taxonomy references on consumers, then the taxonomy tables.
UPDATE "questions" SET "topic_id" = NULL, "chapter_id" = NULL;
UPDATE "ocr_drafts" SET "assigned_topic_id" = NULL, "assigned_chapter_id" = NULL;
DELETE FROM "chapters";
DELETE FROM "topics";

-- DropForeignKey
ALTER TABLE "chapters" DROP CONSTRAINT "chapters_topic_id_fkey";

-- DropForeignKey
ALTER TABLE "topics" DROP CONSTRAINT "topics_subject_id_fkey";

-- DropIndex
DROP INDEX "chapters_tenant_id_topic_id_idx";

-- DropIndex
DROP INDEX "chapters_tenant_id_topic_id_name_key";

-- DropIndex
DROP INDEX "topics_tenant_id_subject_id_idx";

-- DropIndex
DROP INDEX "topics_tenant_id_subject_id_name_key";

-- AlterTable
ALTER TABLE "chapters" DROP COLUMN "topic_id",
ADD COLUMN     "subject_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "questions" ADD COLUMN     "chapter" TEXT;

-- AlterTable
ALTER TABLE "topics" DROP COLUMN "subject_id",
ADD COLUMN     "chapter_id" UUID NOT NULL;

-- CreateIndex
CREATE INDEX "chapters_tenant_id_subject_id_idx" ON "chapters"("tenant_id", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "chapters_tenant_id_subject_id_name_key" ON "chapters"("tenant_id", "subject_id", "name");

-- CreateIndex
CREATE INDEX "topics_tenant_id_chapter_id_idx" ON "topics"("tenant_id", "chapter_id");

-- CreateIndex
CREATE UNIQUE INDEX "topics_tenant_id_chapter_id_name_key" ON "topics"("tenant_id", "chapter_id", "name");

-- AddForeignKey
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topics" ADD CONSTRAINT "topics_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
