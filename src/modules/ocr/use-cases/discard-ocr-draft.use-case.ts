import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OcrDraftModel } from '../models/ocr-draft.model';
import {
  IOcrDraftRepository,
  OCR_DRAFT_REPOSITORY,
} from '../repositories/ocr-draft.repository';

@Injectable()
export class DiscardOcrDraftUseCase {
  constructor(@Inject(OCR_DRAFT_REPOSITORY) private readonly drafts: IOcrDraftRepository) {}

  async execute(input: { tenantId: string; id: string }): Promise<OcrDraftModel> {
    const draft = await this.drafts.findById(input.tenantId, input.id);
    if (!draft) throw new NotFoundException('OCR draft not found');
    if (draft.status === 'APPROVED') {
      throw new ConflictException('Cannot discard an already-approved draft');
    }
    if (draft.status === 'DISCARDED') return draft;
    return this.drafts.update(input.tenantId, input.id, { status: 'DISCARDED' });
  }
}
