-- Tenant-wide configurable exam violation limit (super-admin setting).
-- Defaults to 6, the historical hard-coded MAX_EXAM_VIOLATIONS.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "exam_violation_limit" INTEGER NOT NULL DEFAULT 6;
