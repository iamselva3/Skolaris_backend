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
import {
  IOcrJobRepository,
  OCR_JOB_REPOSITORY,
} from '../repositories/ocr-job.repository';
import {
  IUploadRepository,
  UPLOAD_REPOSITORY,
} from '../../uploads/repositories/upload.repository';
import { OcrDraftModel } from '../models/ocr-draft.model';
import {
  IOcrDraftRepository,
  OCR_DRAFT_REPOSITORY,
} from '../repositories/ocr-draft.repository';

export interface ApproveDraftInput {
  tenantId: string;
  actorUserId: string;
  draftId: string;
  type?: QuestionType;
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
      // Inherit taxonomy from the upload if the approver didn't override it.
      const upload = await this.uploads.findById(input.tenantId, job.uploadId);
      const programId = input.programId ?? upload?.programId ?? undefined;
      const subjectId = input.subjectId ?? upload?.subjectId ?? undefined;

      // The draft's OCR text becomes the question stem. Caller-supplied
      // `correctAnswer` (i.e. fields like { contentHtml, explanation, ... })
      // wins, so manual edits in the approve form aren't clobbered by the
      // raw OCR text. Without this merge, bulk-import produced questions
      // with empty stems because no UI path sends contentHtml during approve.
      const mergedPayload = {
        contentHtml: draftTextToHtml(draft.text),
        ...(input.correctAnswer ?? {}),
      };

      const question = await this.createQuestion.execute({
        tenantId: input.tenantId,
        createdBy: input.actorUserId,
        sourceUploadId: job.uploadId,
        type: resolvedType,
        payload: mergedPayload,
        options: input.options,
        programId,
        subjectId,
        topicId: input.topicId,
        chapterId: input.chapterId,
        subject: input.subject,
        topic: input.topic,
        difficulty: input.difficulty,
      });

      const updatedDraft = await this.drafts.update(input.tenantId, draft.id, {
        status: 'APPROVED',
        approvedQuestionId: question.question.id,
      });

      // If every draft for this job is now approved or discarded, mark upload APPROVED.
      const counts = await this.ocrJobs.countDraftsByStatus(input.tenantId, draft.ocrJobId);
      const total = (counts.APPROVED ?? 0) + (counts.DISCARDED ?? 0) + (counts.PENDING_REVIEW ?? 0) + (counts.EDITED ?? 0);
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
