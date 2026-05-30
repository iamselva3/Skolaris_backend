import { Decimal } from '@prisma/client/runtime/library';
import { QuestionType } from '../../questions/models/question-type.enum';
import { DraftOption, OcrDraftModel, OcrDraftStatus } from '../models/ocr-draft.model';

export const OCR_DRAFT_REPOSITORY = Symbol('OCR_DRAFT_REPOSITORY');

export interface CreateDraftInput {
  tenantId: string;
  ocrJobId: string;
  position: number;
  text: string;
  detectedType?: QuestionType | null;
  options?: DraftOption[] | null;
  confidence?: Decimal | number | null;
}

export interface UpdateDraftInput {
  text?: string;
  detectedType?: QuestionType | null;
  options?: DraftOption[] | null;
  status?: OcrDraftStatus;
  approvedQuestionId?: string | null;
}

export interface IOcrDraftRepository {
  bulkCreate(input: CreateDraftInput[]): Promise<number>;
  list(
    tenantId: string,
    ocrJobId: string,
    limit: number,
    offset: number,
  ): Promise<{ data: OcrDraftModel[]; total: number }>;
  findById(tenantId: string, id: string): Promise<OcrDraftModel | null>;
  update(tenantId: string, id: string, input: UpdateDraftInput): Promise<OcrDraftModel>;
  countByJob(tenantId: string, ocrJobId: string): Promise<number>;
}
