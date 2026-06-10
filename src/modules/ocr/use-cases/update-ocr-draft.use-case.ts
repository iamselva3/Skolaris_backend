import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { QuestionType } from '../../questions/models/question-type.enum';
import { DraftOption, OcrDraftModel } from '../models/ocr-draft.model';
import { IOcrDraftRepository, OCR_DRAFT_REPOSITORY } from '../repositories/ocr-draft.repository';

export interface UpdateOcrDraftInput {
  tenantId: string;
  id: string;
  text?: string;
  detectedType?: QuestionType | null;
  options?: DraftOption[] | null;
}

@Injectable()
export class UpdateOcrDraftUseCase {
  constructor(@Inject(OCR_DRAFT_REPOSITORY) private readonly drafts: IOcrDraftRepository) {}

  async execute(input: UpdateOcrDraftInput): Promise<OcrDraftModel> {
    const draft = await this.drafts.findById(input.tenantId, input.id);
    if (!draft) throw new NotFoundException('OCR draft not found');
    if (draft.status === 'APPROVED' || draft.status === 'DISCARDED') {
      throw new ConflictException(`Cannot edit draft in status ${draft.status}`);
    }
    if (
      input.text === undefined &&
      input.detectedType === undefined &&
      input.options === undefined
    ) {
      throw new BadRequestException('No fields to update');
    }
    return this.drafts.update(input.tenantId, input.id, {
      text: input.text,
      detectedType: input.detectedType,
      options: input.options,
      status: 'EDITED',
    });
  }
}
