import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { IUploadRepository, UPLOAD_REPOSITORY } from '../../uploads/repositories/upload.repository';
import {
  IOcrJobRepository,
  OCR_JOB_REPOSITORY,
  type OcrProgressStage,
} from '../repositories/ocr-job.repository';

export interface OcrProgressSnapshot {
  uploadId: string;
  uploadStatus: string;
  /** Live OCR progress stage when known; mirrors OcrJob.progress.stage. */
  ocrStage: OcrProgressStage | 'PENDING' | null;
  pageProcessed: number;
  pageTotal: number;
  /** Convenience: 0–100 % (or 100 if uploadStatus is terminal). */
  progressPercent: number;
  /** Drafts persisted so far (live during GENERATING_DRAFTS, final after COMPLETED). */
  draftCount: number;
  /** When status is FAILED, the user-facing error. */
  errorMessage: string | null;
}

/**
 * Phase 2 — Live OCR Review UX. Single endpoint the FE polls at ~1s while OCR
 * is in flight, then stops polling and invalidates the drafts query once
 * uploadStatus flips to READY_FOR_REVIEW or FAILED.
 *
 * The progress JSON on OcrJob is written by:
 *   - ocr-job-runner.service.ts (initial OCR_PROCESSING + per-page processed)
 *   - handle-ocr-callback.use-case.ts (GENERATING_DRAFTS → COMPLETED / FAILED)
 *
 * If the upload's OCR job hasn't been created yet (rare race — upload just
 * completed, BullMQ hasn't picked up the job) we return a PENDING stub so the
 * FE can show "queued" rather than 404.
 */
@Injectable()
export class GetOcrProgressUseCase {
  constructor(
    @Inject(OCR_JOB_REPOSITORY) private readonly ocrJobs: IOcrJobRepository,
    @Inject(UPLOAD_REPOSITORY) private readonly uploads: IUploadRepository,
  ) {}

  async execute(input: { tenantId: string; uploadId: string }): Promise<OcrProgressSnapshot> {
    const upload = await this.uploads.findById(input.tenantId, input.uploadId);
    if (!upload) throw new NotFoundException('Upload not found');

    const job = await this.ocrJobs.findByUploadId(input.tenantId, input.uploadId);
    const progress = (job?.progress as Record<string, unknown> | null) ?? null;
    const stage = (progress?.stage as OcrProgressStage | undefined) ?? null;
    const processed = typeof progress?.processed === 'number' ? (progress.processed as number) : 0;
    const total = typeof progress?.total === 'number' ? (progress.total as number) : 0;

    let percent = 0;
    if (upload.status === 'READY_FOR_REVIEW' || stage === 'COMPLETED') percent = 100;
    else if (upload.status === 'FAILED' || stage === 'FAILED') percent = 100;
    else if (total > 0) percent = Math.min(99, Math.round((processed / total) * 100));
    else if (upload.status === 'UPLOADED' || upload.status === 'PROCESSING') percent = 5;

    const draftCounts = job ? await this.ocrJobs.countDraftsByStatus(input.tenantId, job.id) : null;
    const draftCount = draftCounts ? Object.values(draftCounts).reduce((s, n) => s + n, 0) : 0;

    return {
      uploadId: upload.id,
      uploadStatus: upload.status,
      ocrStage: stage ?? (job ? 'OCR_PROCESSING' : 'PENDING'),
      pageProcessed: processed,
      pageTotal: total,
      progressPercent: percent,
      draftCount,
      errorMessage: upload.errorMessage ?? job?.errorMessage ?? null,
    };
  }
}
