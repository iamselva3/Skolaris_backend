import { Decimal } from '@prisma/client/runtime/library';
import { QuestionType } from '../../questions/models/question-type.enum';
import {
  AssignedTaxonomy,
  DraftOption,
  OcrDraftModel,
  OcrDraftStatus,
  SuggestedAnswer,
} from '../models/ocr-draft.model';

export const OCR_DRAFT_REPOSITORY = Symbol('OCR_DRAFT_REPOSITORY');

export interface CreateDraftInput {
  tenantId: string;
  ocrJobId: string;
  position: number;
  text: string;
  detectedType?: QuestionType | null;
  options?: DraftOption[] | null;
  confidence?: Decimal | number | null;
  /** Source page (1-based) in the original PDF/image; optional for legacy callers. */
  sourcePageNumber?: number | null;
  spanPageStart?: number | null;
  spanPageEnd?: number | null;
  solutionText?: string | null;
  questionSnapshotKey?: string | null;
  /** Screenshot-first metadata: detected answer-slot count (2..6) and the
   *  question-region bounding box on the source page. */
  optionCount?: number | null;
  sourceCoordinates?: Record<string, number> | null;
  /** Detected question number + invalid-crop flag (segmentation diagnostics). */
  questionNumber?: number | null;
  invalidCrop?: boolean | null;
}

export interface UpdateDraftInput {
  text?: string;
  detectedType?: QuestionType | null;
  options?: DraftOption[] | null;
  status?: OcrDraftStatus;
  approvedQuestionId?: string | null;
}

/** Figure crop attached to a draft. Slice 2.3. */
export interface CreateDraftFigureInput {
  tenantId: string;
  draftId: string;
  figureIndex: number;
  storageKey: string;
  boundingBox: { x0: number; y0: number; x1: number; y1: number; page: number };
  kind: string;
  caption?: string | null;
}

export interface IOcrDraftRepository {
  /**
   * Bulk-create drafts AND their figures atomically (figures are passed per
   * draft and matched by position). Returns count of drafts written. Figures
   * are inserted in a single createMany after we know the assigned draft ids,
   * which requires looking up the just-created rows by (ocrJobId, position).
   */
  bulkCreate(
    input: Array<
      CreateDraftInput & { figures?: Omit<CreateDraftFigureInput, 'draftId' | 'tenantId'>[] }
    >,
  ): Promise<number>;
  list(
    tenantId: string,
    ocrJobId: string,
    limit: number,
    offset: number,
  ): Promise<{ data: OcrDraftModel[]; total: number }>;
  findById(tenantId: string, id: string): Promise<OcrDraftModel | null>;
  update(tenantId: string, id: string, input: UpdateDraftInput): Promise<OcrDraftModel>;
  countByJob(tenantId: string, ocrJobId: string): Promise<number>;
  /**
   * Bulk-set the imported answer-key suggestion on drafts (one value per id),
   * atomically. Returns the number of drafts updated. Used by answer-key import.
   */
  setSuggestedAnswers(
    tenantId: string,
    items: Array<{ id: string; suggestedAnswer: SuggestedAnswer }>,
  ): Promise<number>;
  /**
   * Bulk-assign taxonomy/difficulty to drafts of a job. `draftIds = null` targets
   * EVERY draft in the job ("apply to all"); a list targets only those ("apply to
   * selected"). Only the provided `taxonomy` fields are written (partial merge).
   * Returns the number of drafts updated.
   */
  setTaxonomy(
    tenantId: string,
    ocrJobId: string,
    draftIds: string[] | null,
    taxonomy: AssignedTaxonomy,
  ): Promise<number>;
  /**
   * Manual recovery: insert a NEW visual draft (from a snipped image) at
   * `atNumber`, shifting every draft with questionNumber ≥ atNumber up by one so
   * numbering stays contiguous. Each shifted draft keeps its own suggestedAnswer,
   * so answer-key mapping moves with the question automatically. Positions are
   * recomputed. Returns the created draft.
   */
  insertDraftAt(input: {
    tenantId: string;
    ocrJobId: string;
    atNumber: number;
    storageKey: string;
    optionCount?: number;
  }): Promise<OcrDraftModel>;
  /**
   * Manual recovery: move a draft to `targetNumber`, shifting the questions in
   * between so numbering stays contiguous (the source of ordering is the question
   * number). suggestedAnswer rides along on each draft. Positions recomputed.
   */
  moveDraftToNumber(
    tenantId: string,
    ocrJobId: string,
    draftId: string,
    targetNumber: number,
  ): Promise<void>;
}
