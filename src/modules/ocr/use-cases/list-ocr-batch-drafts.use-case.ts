import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { IUploadRepository, UPLOAD_REPOSITORY } from '../../uploads/repositories/upload.repository';
import { OcrDraftModel } from '../models/ocr-draft.model';
import { IOcrDraftRepository, OCR_DRAFT_REPOSITORY } from '../repositories/ocr-draft.repository';
import { IOcrJobRepository, OCR_JOB_REPOSITORY } from '../repositories/ocr-job.repository';
import { IOcrBatchRepository, OCR_BATCH_REPOSITORY } from '../repositories/ocr-batch.repository';

export interface BatchDraftRow {
  draft: OcrDraftModel;
  batchSequence: number;
  uploadId: string;
  fileOrder: number;
  sourceFileName: string;
}

export interface ListOcrBatchDraftsResult {
  batchId: string;
  totalDrafts: number;
  rows: BatchDraftRow[];
}

/**
 * Returns every draft across a batch in file order, assigning a continuous
 * `batchSequence` (1..N) at READ TIME. It never mutates stored drafts: each
 * draft keeps its OCR-detected `questionNumber`. Because ordering is derived
 * purely from the current upload order (batchOrder asc) and each file's draft
 * positions, reprocessing one file just refreshes that file's drafts and the
 * sequence is recomputed deterministically — no duplication, no renumbering of
 * the stored data.
 */
@Injectable()
export class ListOcrBatchDraftsUseCase {
  constructor(
    @Inject(OCR_BATCH_REPOSITORY) private readonly batches: IOcrBatchRepository,
    @Inject(UPLOAD_REPOSITORY) private readonly uploads: IUploadRepository,
    @Inject(OCR_JOB_REPOSITORY) private readonly ocrJobs: IOcrJobRepository,
    @Inject(OCR_DRAFT_REPOSITORY) private readonly drafts: IOcrDraftRepository,
  ) {}

  async execute(input: { tenantId: string; batchId: string }): Promise<ListOcrBatchDraftsResult> {
    const batch = await this.batches.findById(input.tenantId, input.batchId);
    if (!batch) throw new NotFoundException('Batch not found');

    const uploads = await this.uploads.listByBatch(input.tenantId, input.batchId);

    const rows: BatchDraftRow[] = [];
    let sequence = 0;

    for (const upload of uploads) {
      const job = await this.ocrJobs.findByUploadId(input.tenantId, upload.id);
      if (!job) continue; // not processed yet, or failed before OCR — no drafts.

      const count = await this.drafts.countByJob(input.tenantId, job.id);
      if (count === 0) continue;

      // Drafts come back ordered by position asc (their in-file order).
      const { data } = await this.drafts.list(input.tenantId, job.id, count, 0);
      for (const draft of data) {
        sequence += 1;
        rows.push({
          draft,
          batchSequence: sequence,
          uploadId: upload.id,
          fileOrder: upload.batchOrder ?? 0,
          sourceFileName: upload.originalName,
        });
      }
    }

    return { batchId: batch.id, totalDrafts: rows.length, rows };
  }
}
