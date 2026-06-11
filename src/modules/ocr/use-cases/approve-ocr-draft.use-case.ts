import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../shared/database/prisma.service';
import { Difficulty, QuestionType } from '../../questions/models/question-type.enum';
import { QuestionWithOptions } from '../../questions/models/question.model';
import { CreateQuestionUseCase } from '../../questions/use-cases/create-question.use-case';
import { IOcrJobRepository, OCR_JOB_REPOSITORY } from '../repositories/ocr-job.repository';
import { IUploadRepository, UPLOAD_REPOSITORY } from '../../uploads/repositories/upload.repository';
import { OcrDraftModel } from '../models/ocr-draft.model';
import { IOcrDraftRepository, OCR_DRAFT_REPOSITORY } from '../repositories/ocr-draft.repository';

export interface ApproveDraftInput {
  tenantId: string;
  actorUserId: string;
  draftId: string;
  type?: QuestionType;
  questionSnapshotKey?: string;
  options?: { label: string; isCorrect: boolean }[];
  correctAnswer?: Record<string, unknown>;
  programId?: string;
  subjectId?: string;
  topicId?: string;
  chapterId?: string;
  subject?: string;
  topic?: string;
  difficulty?: Difficulty;
}

export interface ApproveDraftResult {
  draft: OcrDraftModel;
  question: QuestionWithOptions;
}

@Injectable()
export class ApproveOcrDraftUseCase {
  constructor(
    @Inject(OCR_DRAFT_REPOSITORY) private readonly drafts: IOcrDraftRepository,
    @Inject(OCR_JOB_REPOSITORY) private readonly ocrJobs: IOcrJobRepository,
    @Inject(UPLOAD_REPOSITORY) private readonly uploads: IUploadRepository,
    private readonly createQuestion: CreateQuestionUseCase,
    private readonly prisma: PrismaService,
  ) {}

  async execute(input: ApproveDraftInput): Promise<ApproveDraftResult> {
    const draft = await this.drafts.findById(input.tenantId, input.draftId);
    if (!draft) throw new NotFoundException('OCR draft not found');
    if (draft.status === 'APPROVED') {
      throw new ConflictException('Draft already approved');
    }
    if (draft.status === 'DISCARDED') {
      throw new ConflictException('Draft was discarded');
    }

    const resolvedType = input.type ?? draft.detectedType;
    if (!resolvedType) {
      throw new BadRequestException(
        'Question type could not be resolved (draft has no detectedType and request did not supply one)',
      );
    }

    const job = await this.ocrJobs.findById(input.tenantId, draft.ocrJobId);
    if (!job) throw new NotFoundException('OCR job not found');

    // Atomically: create Question, mark draft APPROVED with approved_question_id.
    return this.prisma.$transaction(async () => {
      // Taxonomy precedence: explicit approve override → the draft's bulk-assigned
      // taxonomy (set once over the batch) → the upload's default.
      const upload = await this.uploads.findById(input.tenantId, job.uploadId);
      const assigned = draft.assignedTaxonomy ?? {};
      const programId = input.programId ?? assigned.programId ?? upload?.programId ?? undefined;
      const subjectId = input.subjectId ?? assigned.subjectId ?? upload?.subjectId ?? undefined;
      const topicId = input.topicId ?? assigned.topicId ?? undefined;
      const chapterId = input.chapterId ?? assigned.chapterId ?? undefined;
      const difficulty = input.difficulty ?? assigned.difficulty ?? undefined;

      // Taxonomy is MANDATORY for approval: a question must never reach the
      // question bank untagged (the review list would show "-- --"). Program,
      // Subject, Topic and Chapter must all resolve (explicit → bulk-assigned →
      // upload default). When incomplete, approval is refused and the draft stays
      // in review — the teacher assigns taxonomy per question or via Bulk Taxonomy
      // (the answer/options already saved on the draft are preserved). Approval
      // status and taxonomy completeness are independent concerns.
      if (!programId || !subjectId || !topicId || !chapterId) {
        const missing = [
          !programId && 'Program',
          !subjectId && 'Subject',
          !chapterId && 'Chapter',
          !topicId && 'Topic',
        ]
          .filter(Boolean)
          .join(', ');
        throw new BadRequestException(
          `Cannot approve without complete taxonomy (missing: ${missing}). ` +
            'Assign it on the question or via Bulk Taxonomy, then approve.',
        );
      }

      // Screenshot-first: when the draft has a cropped question image, that image
      // IS the question content — regardless of answer mode (VISUAL MCQ /
      // TRUE_FALSE / DESCRIPTIVE). We never reconstruct text. The teacher's
      // `correctAnswer` carries the per-mode answer (positional options for MCQ,
      // `correct` for TRUE_FALSE, `rubric`/`explanation` for DESCRIPTIVE). Only
      // when there is NO snapshot do we fall back to the OCR text as the stem.
      if (resolvedType === QuestionType.VISUAL && !draft.questionSnapshotKey) {
        throw new BadRequestException(
          'Cannot approve as VISUAL: this draft has no cropped question image (questionSnapshotKey).',
        );
      }
      let mergedPayload: Record<string, unknown>;
      if (draft.questionSnapshotKey) {
        mergedPayload = {
          contentHtml: snapshotImageHtml(draft.questionSnapshotKey),
          ...(resolvedType === QuestionType.VISUAL
            ? { optionCount: input.options?.length ?? draft.optionCount ?? 4 }
            : {}),
          ...(input.correctAnswer ?? {}),
        };
      } else {
        mergedPayload = {
          contentHtml: draftTextToHtml(draft.text),
          ...(input.correctAnswer ?? {}),
        };
      }

      const question = await this.createQuestion.execute({
        tenantId: input.tenantId,
        createdBy: input.actorUserId,
        sourceUploadId: job.uploadId,
        type: resolvedType,
        payload: mergedPayload,
        options: input.options,
        programId,
        subjectId,
        topicId,
        chapterId,
        subject: input.subject,
        topic: input.topic,
        difficulty,
      });

      const updatedDraft = await this.drafts.update(input.tenantId, draft.id, {
        status: 'APPROVED',
        approvedQuestionId: question.question.id,
        ...(input.questionSnapshotKey ? { questionSnapshotKey: input.questionSnapshotKey } : {}),
      });

      // If every draft for this job is now approved or discarded, mark upload APPROVED.
      const counts = await this.ocrJobs.countDraftsByStatus(input.tenantId, draft.ocrJobId);
      const total =
        (counts.APPROVED ?? 0) +
        (counts.DISCARDED ?? 0) +
        (counts.PENDING_REVIEW ?? 0) +
        (counts.EDITED ?? 0);
      const finalized = (counts.APPROVED ?? 0) + (counts.DISCARDED ?? 0);
      if (total > 0 && total === finalized) {
        await this.uploads.updateStatus(input.tenantId, job.uploadId, 'APPROVED');
      }

      return { draft: updatedDraft, question };
    });
  }
}

/**
 * Naive plain-text → HTML: wraps each non-empty line in <p>. Good enough for
 * OCR output where most stems are single paragraphs. Escapes &, <, > so raw
 * OCR characters can't inject markup.
 */
const draftTextToHtml = (text: string): string => {
  if (!text) return '';
  return text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => `<p>${escapeHtml(l)}</p>`)
    .join('');
};

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Build the <img> stem for a VISUAL question from an R2 snapshot key. The URL
 * uses the canonical read-proxy path (/storage/v1/b/<bucket>/o/<key>); the
 * frontend's normalizeStorageUrls() rewrites the origin to the current read
 * host at render time, so the stored origin is just a placeholder.
 */
const STORAGE_READ_BASE = (process.env.STORAGE_READ_BASE_URL || 'http://localhost:4443').replace(
  /\/+$/,
  '',
);
const SNAPSHOT_BUCKET = process.env.AWS_S3_BUCKET || 'skolaris-uploads';
const snapshotImageHtml = (key: string): string => {
  const url = `${STORAGE_READ_BASE}/storage/v1/b/${encodeURIComponent(
    SNAPSHOT_BUCKET,
  )}/o/${encodeURIComponent(key)}?alt=media`;
  return `<p><img src="${url}" alt="Question image" class="max-w-full rounded border border-border my-2" /></p>`;
};
