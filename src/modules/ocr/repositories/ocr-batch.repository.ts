import { OcrBatchModel } from '../models/ocr-batch.model';

export const OCR_BATCH_REPOSITORY = Symbol('OCR_BATCH_REPOSITORY');

export interface CreateOcrBatchInput {
  tenantId: string;
  createdBy: string;
  totalFiles: number;
}

/**
 * Aggregated batch summary for the uploads queue — one collapsed row per batch.
 * Counts are derived from the batch's uploads + their OcrJob draft counts (read
 * time; the underlying single-file pipeline is untouched).
 */
export interface OcrBatchListItem {
  batchId: string;
  totalFiles: number;
  fileCount: number;
  /** Total drafts (questions) extracted across every file in the batch. */
  questionCount: number;
  completed: number;
  failed: number;
  /** True while any file is still queued/processing. */
  processing: boolean;
  /** The lowest-order upload's id — used as the route param for batch review. */
  firstUploadId: string | null;
  createdAt: Date;
}

export interface IOcrBatchRepository {
  create(input: CreateOcrBatchInput): Promise<OcrBatchModel>;
  findById(tenantId: string, id: string): Promise<OcrBatchModel | null>;
  listByTenant(
    tenantId: string,
    limit: number,
    offset: number,
  ): Promise<{ data: OcrBatchListItem[]; total: number }>;
}
