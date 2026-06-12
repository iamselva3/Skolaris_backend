-- Communication history / audit log (institution-sent broadcasts).
-- Separate from the per-recipient `notifications` table (which powers the
-- personal notification bell). One row per broadcast: title, type, channel,
-- audience size, sender, and delivery outcome. No per-recipient rows yet —
-- recipient detail is summarised as counts.

-- CreateEnum
CREATE TYPE "DeliveryChannel" AS ENUM ('EMAIL', 'SMS', 'PUSH', 'WHATSAPP', 'IN_APP');

-- CreateEnum
CREATE TYPE "CommunicationType" AS ENUM ('EXAM_ALERT', 'REPORT_PUBLISHED', 'ATTENDANCE_ALERT', 'FEE_REMINDER', 'CIRCULAR', 'ANNOUNCEMENT', 'GENERAL');

-- CreateEnum
CREATE TYPE "CommunicationStatus" AS ENUM ('SENT', 'FAILED', 'SCHEDULED', 'PARTIAL');

-- CreateTable
CREATE TABLE "communications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "type" "CommunicationType" NOT NULL,
    "channel" "DeliveryChannel" NOT NULL,
    "status" "CommunicationStatus" NOT NULL DEFAULT 'SENT',
    "audience" TEXT,
    "recipient_count" INTEGER NOT NULL DEFAULT 0,
    "delivered_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "sent_by_id" UUID,
    "sent_by_name" TEXT,
    "scheduled_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "communications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "communications_tenant_id_sent_at_idx" ON "communications"("tenant_id", "sent_at");

-- CreateIndex
CREATE INDEX "communications_tenant_id_type_idx" ON "communications"("tenant_id", "type");

-- CreateIndex
CREATE INDEX "communications_tenant_id_channel_idx" ON "communications"("tenant_id", "channel");

-- CreateIndex
CREATE INDEX "communications_tenant_id_status_idx" ON "communications"("tenant_id", "status");

-- AddForeignKey
ALTER TABLE "communications" ADD CONSTRAINT "communications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communications" ADD CONSTRAINT "communications_sent_by_id_fkey" FOREIGN KEY ("sent_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
