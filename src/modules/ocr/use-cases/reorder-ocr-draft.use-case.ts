import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { IOcrDraftRepository, OCR_DRAFT_REPOSITORY } from '../repositories/ocr-draft.repository';

export interface ReorderOcrDraftInput {
  tenantId: string;
  draftId: string;
  /** New 1-based question number for this draft; the rest renumber around it. */
  toQuestionNumber: number;
}

/**
 * Manual recovery — drag-reorder: move a draft to a new question number. The
 * navigator is the source of ordering; everything between the old and new number
 * shifts so numbering stays contiguous (and each draft's suggestedAnswer rides
 * along, keeping answer-key mapping in sync).
 */
@Injectable()
export class ReorderOcrDraftUseCase {
  constructor(@Inject(OCR_DRAFT_REPOSITORY) private readonly drafts: IOcrDraftRepository) {}

  async execute(input: ReorderOcrDraftInput): Promise<void> {
    if (!Number.isInteger(input.toQuestionNumber) || input.toQuestionNumber < 1) {
      throw new BadRequestException('toQuestionNumber must be a positive integer');
    }
    const draft = await this.drafts.findById(input.tenantId, input.draftId);
    if (!draft) throw new NotFoundException('OCR draft not found');
    await this.drafts.moveDraftToNumber(
      input.tenantId,
      draft.ocrJobId,
      input.draftId,
      input.toQuestionNumber,
    );
  }
}
