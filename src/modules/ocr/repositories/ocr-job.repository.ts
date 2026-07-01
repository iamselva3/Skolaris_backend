import { Decimal } from '@prisma/client/runtime/library';
import type { CachedPageOcr } from '../../../shared/ocr-engine/ocr-engine';
import type { OcrCallbackDto } from '../dtos/ocr-callback.dto';
import { OcrJobModel } from '../models/ocr-job.model';

export const OCR_JOB_REPOSITORY = Symbol('OCR_JOB_REPOSITORY');

export interface CreateOcrJobInput {
  tenantId: string;
  uploadId: string;
}

/**
 * Resumable OCR (P0) — durable lifecycle. A crash/restart/timeout NEVER restarts
 * from page 1; the job moves through these states and resumes from the last
 * checkpointed page.
 *   QUEUED      accepted, not yet running
 *   PROCESSING  actively OCRing; per-page checkpoints accumulating
 *   PAUSED      execution stopped (crash/timeout) but checkpoints intact → resumable
 *   RESUMING    recovery re-dispatched it; flips to PROCESSING when run() starts
 *   COMPLETED   drafts persisted (terminal happy)
 *   FAILED      non-recoverable / attempts exhausted (terminal sad)
 */
export type OcrJobStatus =
  | 'QUEUED'
  | 'PROCESSING'
  | 'PAUSED'
  | 'RESUMING'
  | 'COMPLETED'
  | 'FAILED';

/** A non-terminal OCR job eligible for auto-resume (joined with its upload). */
export interface ResumableOcrJob {
  id: string;
  tenantId: string;
  uploadId: string;
  storageKey: string;
  status: string | null;
  attemptCount: number;
  lastCompletedPage: number;
}

/**
 * Live progress stages — Phase 2 (live OCR review UX). Stored as the `stage`
 * key inside OcrJob.progress JSON. Transitions:
 *   QUEUED           (accepted but not started — waiting behind an in-flight inline
 *                     OCR job; carries `queuePosition` = jobs ahead. The UI shows
 *                     "Queued · waiting for previous OCR job" instead of a fake 5%)
 *   OCR_PROCESSING   (per-page tesseract / paddle work; `processed` increments)
 *   EXTRACTING       (parseDrafts running)
 *   GENERATING_DRAFTS (callback in progress — inside the transaction)
 *   COMPLETED        (terminal happy)
 *   FAILED           (terminal sad — also writes OcrJob.errorMessage)
 */
export type OcrProgressStage =
  | 'QUEUED'
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
      /** Jobs ahead of this one on the inline serial queue (0 = next to run). */
      queuePosition?: number;
    },
  ): Promise<void>;

  // ─── Resumable OCR (P0) ───────────────────────────────────────────────────

  /** Transition to PROCESSING for a (re)start: bumps attemptCount, sets startedAt
   *  once, clears any prior pause/error. Returns the new attemptCount. */
  markRunning(id: string): Promise<{ attemptCount: number }>;

  /** Stop the current execution but KEEP checkpoints (resumable). Does NOT fail
   *  the upload — recovery will resume it. */
  markPaused(id: string, reason: string): Promise<void>;

  /** Mark a job picked up by recovery as RESUMING (run() will flip it to PROCESSING). */
  markResuming(id: string): Promise<void>;

  /** Terminal success: status COMPLETED + clear this job's page checkpoints. */
  markCompletedStatus(id: string): Promise<void>;

  /** Persist one page's OCR artifact AFTER it completes. Bumps lastCompletedPage
   *  (GREATEST), records totalPages, and touches Upload.updatedAt (liveness). */
  savePageCheckpoint(
    id: string,
    pageNumber: number,
    totalPages: number,
    artifact: CachedPageOcr,
  ): Promise<void>;

  /** Load a previously-checkpointed page artifact, or null if not yet done. */
  loadPageCheckpoint(id: string, pageNumber: number): Promise<CachedPageOcr | null>;

  /**
   * TRUE RESUME (Option A) — result-level checkpoint. Persists the FINAL callback
   * input (drafts + crop keys + page metadata) produced AFTER segmentation/delivery,
   * just before the terminal callback. A restart can then finish the job by replaying
   * this WITHOUT re-running ocrPdf (no render / flat field / mask / Tesseract / OCR loop).
   * Stored as the sentinel pageNumber=0 row in OcrPageCheckpoint (real pages are 1-based),
   * so it requires NO migration and is cleared together with the page checkpoints by
   * markCompletedStatus.
   */
  saveResultCheckpoint(id: string, result: OcrCallbackDto): Promise<void>;

  /** Load the result-level checkpoint, or null if segmentation never finished. */
  loadResultCheckpoint(id: string): Promise<OcrCallbackDto | null>;

  /** Non-terminal jobs eligible for auto-resume. `includeFresh=true` (bootstrap)
   *  returns every in-flight job; otherwise only PAUSED jobs or stale ones whose
   *  Upload.updatedAt is older than `staleBefore` (hung mid-run). */
  findResumable(opts: {
    maxAttempts: number;
    staleBefore: Date;
    includeFresh: boolean;
  }): Promise<ResumableOcrJob[]>;

  /** Terminally FAIL non-terminal jobs that have exhausted `maxAttempts` (also
   *  fails their uploads). Returns the number affected. */
  failExhausted(maxAttempts: number, reason: string): Promise<number>;
}
