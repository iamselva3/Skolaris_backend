import { Decimal } from '@prisma/client/runtime/library';
import { Difficulty, QuestionType } from '../../questions/models/question-type.enum';

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

  /** R2 storage key of a cropped page region covering the source question.
   *  Screenshot-first OCR makes this the Visual Question's source of truth
   *  (set by the engine's region attacher); also the low-confidence fallback. */
  public questionSnapshotKey: string | null = null;

  /** Number of answer slots detected on the crop (2..6). Drives the positional
   *  option radios in the visual review card. Null when undetected. */
  public optionCount: number | null = null;

  /** Detected question number at the top of this crop (e.g. 103). Powers the
   *  Question Navigator's reliable count + missing/merged status, and answer-key
   *  mapping. Null when no number was read. */
  public questionNumber: number | null = null;

  /** True when the crop has no question number/stem/marker (diagram/footer/option
   *  fragment) — flagged for review, not counted as a real question. */
  public invalidCrop: boolean | null = null;

  /** Bounding box of the question region on the source page
   *  { x0, y0, x1, y1 } (and optionally page). Metadata for dedup/debug. */
  public sourceCoordinates: Record<string, number> | null = null;

  /** Pre-filled correct answer mapped from an imported answer key, so the review
   *  UI pre-selects it and the teacher only fixes exceptions. Null until an
   *  answer key is imported. Shape: { source, raw, correctIndex?, correct? }. */
  public suggestedAnswer: SuggestedAnswer | null = null;

  /** Bulk-assigned taxonomy + difficulty (Program/Subject/Chapter/Topic) applied
   *  once over the OCR batch. Review-time defaults the approve flow inherits
   *  unless overridden. Fields are null until a bulk assignment sets them. */
  public assignedTaxonomy: AssignedTaxonomy = {};
}

/** Bulk-assigned, review-time taxonomy defaults for an OCR draft. All optional —
 *  a bulk assignment may set any subset (e.g. just Subject + Chapter). */
export interface AssignedTaxonomy {
  programId?: string | null;
  subjectId?: string | null;
  topicId?: string | null;
  chapterId?: string | null;
  difficulty?: Difficulty | null;
}

/** A correct answer pre-filled from an imported answer key. `correctIndex` is a
 *  1-based option position (A→1) for MCQ/VISUAL; `correct` is the boolean for
 *  TRUE_FALSE. Exactly one of the two is set. */
export interface SuggestedAnswer {
  source: 'answer-key';
  /** The raw token from the key ("A", "3", "TRUE"). */
  raw: string;
  correctIndex?: number;
  correct?: boolean;
}
