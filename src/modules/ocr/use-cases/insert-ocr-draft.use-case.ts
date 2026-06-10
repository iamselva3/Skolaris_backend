import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { QuestionType } from '../../questions/models/question-type.enum';
import { IOcrJobRepository, OCR_JOB_REPOSITORY } from '../repositories/ocr-job.repository';
import { IOcrDraftRepository, OCR_DRAFT_REPOSITORY } from '../repositories/ocr-draft.repository';
import { OcrDraftModel } from '../models/ocr-draft.model';
import { ApproveOcrDraftUseCase } from './approve-ocr-draft.use-case';

export interface InsertOcrDraftInput {
  tenantId: string;
  actorUserId: string;
  ocrJobId: string;
  /** R2 storage key of the snipped question image (uploaded by the FE first). */
  storageKey: string;
  /** Question number to insert at; existing questions ≥ this shift up by one. */
  questionNumber: number;
  optionCount?: number;
  /** When set, the draft is APPROVED immediately into a complete Visual Question
   *  (manual adds skip the OCR-review step). */
  correctOption?: number;
  solutionHtml?: string;
}

/**
 * Manual recovery — create a visual draft from a teacher's snip and insert it at
 * a chosen question number, renumbering the rest. When a `correctOption` is
 * given, the draft is approved straight away so the manually-added question is
 * complete and needs no separate review.
 */
@Injectable()
export class InsertOcrDraftUseCase {
  constructor(
    @Inject(OCR_DRAFT_REPOSITORY) private readonly drafts: IOcrDraftRepository,
    @Inject(OCR_JOB_REPOSITORY) private readonly ocrJobs: IOcrJobRepository,
    private readonly approve: ApproveOcrDraftUseCase,
  ) {}

  async execute(input: InsertOcrDraftInput): Promise<OcrDraftModel> {
    if (!input.storageKey?.trim()) throw new BadRequestException('storageKey is required');
    if (!Number.isInteger(input.questionNumber) || input.questionNumber < 1) {
      throw new BadRequestException('questionNumber must be a positive integer');
    }
    const job = await this.ocrJobs.findById(input.tenantId, input.ocrJobId);
    if (!job) throw new NotFoundException('OCR job not found');

    const optionCount = input.optionCount ?? 4;
    const draft = await this.drafts.insertDraftAt({
      tenantId: input.tenantId,
      ocrJobId: input.ocrJobId,
      atNumber: input.questionNumber,
      storageKey: input.storageKey,
      optionCount,
    });

    // No answer chosen → leave it as a pending draft for later review.
    if (!input.correctOption) return draft;

    // Approve immediately into a complete Visual Question (one positional option
    // correct). Taxonomy is inherited from the upload by the approve flow.
    const result = await this.approve.execute({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      draftId: draft.id,
      type: QuestionType.VISUAL,
      options: Array.from({ length: optionCount }, (_, i) => ({
        label: String(i + 1),
        isCorrect: i + 1 === input.correctOption,
      })),
      correctAnswer: input.solutionHtml ? { explanation: input.solutionHtml } : {},
    });
    return result.draft;
  }
}
