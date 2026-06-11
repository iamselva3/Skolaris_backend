-- Re-parent taxonomy: Program → Subject → Chapter → Topic.
-- Direct-apply variant of migration 20262702000000_reparent_taxonomy_chapter_over_topic
-- for databases whose Prisma migration history does NOT match the repo folder
-- (apply via `prisma db execute`, NOT `prisma migrate deploy`).
--
-- OCR-SAFE: ocr_drafts is intentionally NOT modified (its assigned_topic_id /
-- assigned_chapter_id are plain columns with no FK, so deleting taxonomy rows
-- does not require touching them). OCR extraction/segmentation/drafts untouched.
--
-- Taxonomy rows are reset because the new parent FK columns are NOT NULL and
-- cannot be backfilled from the inverted hierarchy.

BEGIN;

-- reset taxonomy references on questions, then the taxonomy tables
UPDATE "questions" SET "topic_id" = NULL, "chapter_id" = NULL;
DELETE FROM "chapters";
DELETE FROM "topics";

-- structural re-parent
ALTER TABLE "chapters" DROP CONSTRAINT "chapters_topic_id_fkey";
ALTER TABLE "topics"   DROP CONSTRAINT "topics_subject_id_fkey";

DROP INDEX "chapters_tenant_id_topic_id_idx";
DROP INDEX "chapters_tenant_id_topic_id_name_key";
DROP INDEX "topics_tenant_id_subject_id_idx";
DROP INDEX "topics_tenant_id_subject_id_name_key";

ALTER TABLE "chapters" DROP COLUMN "topic_id",   ADD COLUMN "subject_id" UUID NOT NULL;
ALTER TABLE "questions" ADD COLUMN "chapter" TEXT;
ALTER TABLE "topics"   DROP COLUMN "subject_id", ADD COLUMN "chapter_id" UUID NOT NULL;

CREATE INDEX "chapters_tenant_id_subject_id_idx" ON "chapters"("tenant_id", "subject_id");
CREATE UNIQUE INDEX "chapters_tenant_id_subject_id_name_key" ON "chapters"("tenant_id", "subject_id", "name");
CREATE INDEX "topics_tenant_id_chapter_id_idx" ON "topics"("tenant_id", "chapter_id");
CREATE UNIQUE INDEX "topics_tenant_id_chapter_id_name_key" ON "topics"("tenant_id", "chapter_id", "name");

ALTER TABLE "chapters" ADD CONSTRAINT "chapters_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "topics"   ADD CONSTRAINT "topics_chapter_id_fkey"   FOREIGN KEY ("chapter_id") REFERENCES "chapters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
