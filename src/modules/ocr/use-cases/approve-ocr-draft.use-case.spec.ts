import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { OcrDraftModel } from '../models/ocr-draft.model';
import { OcrJobModel } from '../models/ocr-job.model';
import { IOcrDraftRepository } from '../repositories/ocr-draft.repository';
import { IOcrJobRepository } from '../repositories/ocr-job.repository';
import { IUploadRepository } from '../../uploads/repositories/upload.repository';
import { QuestionType } from '../../questions/models/question-type.enum';
import { CreateQuestionUseCase } from '../../questions/use-cases/create-question.use-case';
import { QuestionModel } from '../../questions/models/question.model';
import { ApproveOcrDraftUseCase } from './approve-ocr-draft.use-case';

const fakePrisma = {
  $transaction: async <T>(cb: () => Promise<T>) => cb(),
} as unknown as import('../../../shared/database/prisma.service').PrismaService;

const draft = (overrides: Partial<OcrDraftModel> = {}): OcrDraftModel =>
  new OcrDraftModel(
    overrides.id ?? 'd-1',
    overrides.tenantId ?? 'tenant-1',
    overrides.ocrJobId ?? 'job-1',
    overrides.position ?? 0,
    overrides.text ?? '2+2 = ?',
    overrides.detectedType ?? QuestionType.SINGLE_CHOICE,
    overrides.options ?? null,
    overrides.confidence ?? new Decimal('0.9'),
    overrides.status ?? 'PENDING_REVIEW',
    overrides.approvedQuestionId ?? null,
    overrides.createdAt ?? new Date(),
    overrides.updatedAt ?? new Date(),
  );

// Approval now REQUIRES complete taxonomy; success cases must supply it (the
// upload mock returns null, so there is no upload-level fallback).
const COMPLETE_TAXONOMY = {
  programId: 'p-1',
  subjectId: 's-1',
  topicId: 't-1',
  chapterId: 'c-1',
};

describe('ApproveOcrDraftUseCase', () => {
  let drafts: jest.Mocked<IOcrDraftRepository>;
  let ocrJobs: jest.Mocked<IOcrJobRepository>;
  let uploads: jest.Mocked<IUploadRepository>;
  let createQuestion: jest.Mocked<CreateQuestionUseCase>;
  let useCase: ApproveOcrDraftUseCase;

  beforeEach(() => {
    drafts = {
      bulkCreate: jest.fn(),
      list: jest.fn(),
      findById: jest.fn(),
      update: jest.fn().mockImplementation(async (_, id, input) =>
        draft({
          id,
          status: input.status ?? 'APPROVED',
          approvedQuestionId: input.approvedQuestionId ?? null,
        }),
      ),
      countByJob: jest.fn(),
      setSuggestedAnswers: jest.fn(),
      setTaxonomy: jest.fn(),
      insertDraftAt: jest.fn(),
      moveDraftToNumber: jest.fn(),
    };
    ocrJobs = {
      create: jest.fn(),
      findById: jest
        .fn()
        .mockResolvedValue(
          new OcrJobModel(
            'job-1',
            'tenant-1',
            'upload-1',
            new Date(),
            null,
            null,
            null,
            null,
            null,
            null,
            new Date(),
            new Date(),
          ),
        ),
      findByIdAnyTenant: jest.fn(),
      findByUploadId: jest.fn(),
      countDraftsByStatus: jest
        .fn()
        .mockResolvedValue({ APPROVED: 1, DISCARDED: 0, PENDING_REVIEW: 1, EDITED: 0 }),
      markFinished: jest.fn(),
      markFailed: jest.fn(),
      updateProgress: jest.fn(),
    };
    uploads = {
      create: jest.fn(),
      findById: jest.fn().mockResolvedValue(null),
      list: jest.fn(),
      updateStatus: jest.fn(),
      failStuckProcessing: jest.fn(),
      remove: jest.fn(),
      assignBatch: jest.fn(),
      listByBatch: jest.fn(),
    };
    createQuestion = {
      execute: jest.fn().mockResolvedValue({
        question: new QuestionModel(
          'q-1',
          'tenant-1',
          'teacher-1',
          'upload-1',
          QuestionType.SINGLE_CHOICE,
          {},
          null,
          null,
          null,
          null,
          null,
          null,
          'EASY' as never,
          true,
          new Date(),
          new Date(),
        ),
        options: [],
      }),
    } as unknown as jest.Mocked<CreateQuestionUseCase>;

    useCase = new ApproveOcrDraftUseCase(drafts, ocrJobs, uploads, createQuestion, fakePrisma);
  });

  it('creates question, marks draft APPROVED with question id', async () => {
    drafts.findById.mockResolvedValue(draft());

    const r = await useCase.execute({
      tenantId: 'tenant-1',
      actorUserId: 'teacher-1',
      draftId: 'd-1',
      ...COMPLETE_TAXONOMY,
      options: [
        { label: '3', isCorrect: false },
        { label: '4', isCorrect: true },
      ],
    });

    expect(createQuestion.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        type: QuestionType.SINGLE_CHOICE,
        sourceUploadId: 'upload-1',
        options: [
          { label: '3', isCorrect: false },
          { label: '4', isCorrect: true },
        ],
      }),
    );
    expect(drafts.update).toHaveBeenCalledWith(
      'tenant-1',
      'd-1',
      expect.objectContaining({ status: 'APPROVED', approvedQuestionId: 'q-1' }),
    );
    expect(r.question.question.id).toBe('q-1');
  });

  it('marks the upload APPROVED once every draft is finalized', async () => {
    drafts.findById.mockResolvedValue(draft());
    ocrJobs.countDraftsByStatus.mockResolvedValue({
      APPROVED: 3,
      DISCARDED: 0,
      PENDING_REVIEW: 0,
      EDITED: 0,
    });

    await useCase.execute({
      tenantId: 'tenant-1',
      actorUserId: 'teacher-1',
      draftId: 'd-1',
      type: QuestionType.TRUE_FALSE,
      correctAnswer: { correct: true },
      ...COMPLETE_TAXONOMY,
    });

    expect(uploads.updateStatus).toHaveBeenCalledWith('tenant-1', 'upload-1', 'APPROVED');
  });

  it('refuses approval when taxonomy is incomplete and creates no question', async () => {
    drafts.findById.mockResolvedValue(draft());

    await expect(
      useCase.execute({
        tenantId: 'tenant-1',
        actorUserId: 'teacher-1',
        draftId: 'd-1',
        // Only Program + Subject — Topic and Chapter missing, no upload fallback.
        programId: 'p-1',
        subjectId: 's-1',
        options: [{ label: '4', isCorrect: true }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(createQuestion.execute).not.toHaveBeenCalled();
    expect(drafts.update).not.toHaveBeenCalled();
  });

  it('rejects an already-approved draft', async () => {
    drafts.findById.mockResolvedValue(draft({ status: 'APPROVED' }));
    await expect(
      useCase.execute({ tenantId: 'tenant-1', actorUserId: 't', draftId: 'd-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a discarded draft', async () => {
    drafts.findById.mockResolvedValue(draft({ status: 'DISCARDED' }));
    await expect(
      useCase.execute({ tenantId: 'tenant-1', actorUserId: 't', draftId: 'd-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws 404 when draft missing', async () => {
    drafts.findById.mockResolvedValue(null);
    await expect(
      useCase.execute({ tenantId: 'tenant-1', actorUserId: 't', draftId: 'd-1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
