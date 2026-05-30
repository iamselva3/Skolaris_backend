import { Decimal } from '@prisma/client/runtime/library';
import { QuestionType } from '../../questions/models/question-type.enum';

export type OcrDraftStatus = 'PENDING_REVIEW' | 'EDITED' | 'APPROVED' | 'DISCARDED';

export interface DraftOption {
  label: string;
  isCorrect?: boolean;
}

export class OcrDraftModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly ocrJobId: string,
    public readonly position: number,
    public readonly text: string,
    public readonly detectedType: QuestionType | null,
    public readonly options: DraftOption[] | null,
    public readonly confidence: Decimal | null,
    public readonly status: OcrDraftStatus,
    public readonly approvedQuestionId: string | null,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}
}
