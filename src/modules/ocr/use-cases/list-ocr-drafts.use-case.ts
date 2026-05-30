import { Inject, Injectable } from '@nestjs/common';
import { PaginatedResponse } from '../../../shared/common/dtos/paginated-response.dto';
import { OcrDraftModel } from '../models/ocr-draft.model';
import {
  IOcrDraftRepository,
  OCR_DRAFT_REPOSITORY,
} from '../repositories/ocr-draft.repository';

@Injectable()
export class ListOcrDraftsUseCase {
  constructor(@Inject(OCR_DRAFT_REPOSITORY) private readonly drafts: IOcrDraftRepository) {}

  async execute(input: {
    tenantId: string;
    ocrJobId: string;
    limit: number;
    offset: number;
  }): Promise<PaginatedResponse<OcrDraftModel>> {
    const { data, total } = await this.drafts.list(
      input.tenantId,
      input.ocrJobId,
      input.limit,
      input.offset,
    );
    return { data, meta: { total, limit: input.limit, offset: input.offset } };
  }
}
