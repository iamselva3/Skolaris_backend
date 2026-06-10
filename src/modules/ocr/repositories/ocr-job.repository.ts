import { Decimal } from '@prisma/client/runtime/library';
import { OcrJobModel } from '../models/ocr-job.model';

export const OCR_JOB_REPOSITORY = Symbol('OCR_JOB_REPOSITORY');

export interface CreateOcrJobInput {
  tenantId: string;
  uploadId: string;
}

/**
 * Live progress stages — Phase 2 (live OCR review UX). Stored as the `stage`
 * key inside OcrJob.progress JSON. Transitions:
 *   OCR_PROCESSING   (per-page tesseract / paddle work; `processed` increments)
 *   EXTRACTING       (parseDrafts running)
 *   GENERATING_DRAFTS (callback in progress — inside the transaction)
 *   COMPLETED        (terminal happy)
 *   FAILED           (terminal sad — also writes OcrJob.errorMessage)
 */
export type OcrProgressStage =
  | 'OCR_PROCESSING'
  | 'EXTRACTING'
  | 'GENERATING_DRAFTS'
  | 'COMPLETED'
  | 'FAILED';

export interface IOcrJobRepository {
  create(input: CreateOcrJobInput): Promise<OcrJobModel>;
  findById(tenantId: string, id: string): Promise<OcrJobModel | null>;
  findByIdAnyTenant(id: string): Promise<OcrJobModel | null>;
  findByUploadId(tenantId: string, uploadId: string): Promise<OcrJobModel | null>;
  countDraftsByStatus(tenantId: string, ocrJobId: string): Promise<Record<string, number>>;
  markFinished(input: {
    id: string;
    overallConfidence: Decimal | null;
    rawOutput: unknown;
    providerUsed: string | null;
    /** Per-page classification — persisted on OcrJob.pageMetadata. Null leaves it untouched. */
    pageMetadata?: unknown | null;
  }): Promise<OcrJobModel>;
  markFailed(input: { id: string; errorMessage: string }): Promise<OcrJobModel>;
  /**
   * Merge-update the `progress` JSON field — Phase 2. Partial input merges with
   * whatever's already there so the per-page callback can bump `processed`
   * without losing `stage`, and the stage transitions can flip `stage` without
   * losing `processed`. Idempotent; safe to call rapidly during page loops.
   */
  updateProgress(
    id: string,
    progress: {
      stage?: OcrProgressStage;
      processed?: number;
      total?: number;
      currentPage?: number;
    },
  ): Promise<void>;
}
