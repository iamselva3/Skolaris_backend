import { Inject, Injectable } from '@nestjs/common';
import {
  IOcrBatchRepository,
  OCR_BATCH_REPOSITORY,
  OcrBatchListItem,
} from '../repositories/ocr-batch.repository';

/**
 * List OCR batches for the uploads queue — one collapsed summary row per batch.
 * Read-only aggregation over the unchanged single-file pipeline; the queue page
 * renders these alongside standalone (non-batch) uploads.
 */
@Injectable()
export class ListOcrBatchesUseCase {
  constructor(@Inject(OCR_BATCH_REPOSITORY) private readonly batches: IOcrBatchRepository) {}

  async execute(input: {
    tenantId: string;
    limit: number;
    offset: number;
  }): Promise<{ data: OcrBatchListItem[]; total: number }> {
    return this.batches.listByTenant(input.tenantId, input.limit, input.offset);
  }
}
