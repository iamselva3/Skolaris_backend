-- Multi-file OCR import batch (orchestration only — the OCR pipeline is unchanged).
-- OcrBatch groups uploads imported together; uploads gain a nullable batch link +
-- order. Existing single-file uploads keep batch_id / batch_order NULL and are
-- unaffected.

-- CreateTable
CREATE TABLE "ocr_batches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "total_files" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ocr_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ocr_batches_tenant_id_idx" ON "ocr_batches"("tenant_id");

-- AlterTable
ALTER TABLE "uploads" ADD COLUMN "batch_id" UUID;
ALTER TABLE "uploads" ADD COLUMN "batch_order" INTEGER;

-- CreateIndex
CREATE INDEX "uploads_tenant_id_batch_id_idx" ON "uploads"("tenant_id", "batch_id");

-- AddForeignKey
ALTER TABLE "ocr_batches" ADD CONSTRAINT "ocr_batches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ocr_batches" ADD CONSTRAINT "ocr_batches_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "ocr_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
