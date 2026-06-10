import { OcrDraftModel } from '../models/ocr-draft.model';
import { OcrBatchListItem } from '../repositories/ocr-batch.repository';
import { OcrDraftResponse, toOcrDraftResponse } from './ocr-responses';

/**
 * A batch-review draft row. It is a normal draft response PLUS two read-only,
 * computed-at-read-time fields:
 *   - batchSequence: continuous 1..N index across the whole batch (file order →
 *     in-file position). Convenience for the review screen only.
 *   - originalQuestionNumber: the OCR-detected number on the page. This is the
 *     source of truth and is NEVER overwritten — it mirrors the stored
 *     `questionNumber` and resets per file exactly as OCR produced it.
 * Provenance fields locate which file a draft came from.
 */
export interface OcrBatchDraftResponse extends OcrDraftResponse {
  batchSequence: number;
  originalQuestionNumber: number | null;
  uploadId: string;
  fileOrder: number;
  sourceFileName: string;
}

export const toOcrBatchDraftResponse = (
  d: OcrDraftModel,
  ctx: { batchSequence: number; uploadId: string; fileOrder: number; sourceFileName: string },
): OcrBatchDraftResponse => {
  const base = toOcrDraftResponse(d);
  return {
    ...base,
    batchSequence: ctx.batchSequence,
    // Source of truth — the OCR-detected number, untouched.
    originalQuestionNumber: base.questionNumber,
    uploadId: ctx.uploadId,
    fileOrder: ctx.fileOrder,
    sourceFileName: ctx.sourceFileName,
  };
};

/** One collapsed batch row for the uploads queue. */
export interface OcrBatchListItemResponse {
  batchId: string;
  totalFiles: number;
  fileCount: number;
  questionCount: number;
  completed: number;
  failed: number;
  processing: boolean;
  firstUploadId: string | null;
  createdAt: string;
}

export const toOcrBatchListItemResponse = (b: OcrBatchListItem): OcrBatchListItemResponse => ({
  batchId: b.batchId,
  totalFiles: b.totalFiles,
  fileCount: b.fileCount,
  questionCount: b.questionCount,
  completed: b.completed,
  failed: b.failed,
  processing: b.processing,
  firstUploadId: b.firstUploadId,
  createdAt: b.createdAt.toISOString(),
});
