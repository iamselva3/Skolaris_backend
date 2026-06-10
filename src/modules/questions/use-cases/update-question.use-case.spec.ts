import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { Difficulty, QuestionType } from '../models/question-type.enum';
import { QuestionModel, QuestionOptionModel } from '../models/question.model';
import { TaxonomyResolverService } from '../../taxonomy/services/taxonomy-resolver.service';
import { IQuestionRepository } from '../repositories/question.repository';
import { QuestionPayloadValidator } from '../services/question-payload-validator.service';
import { UpdateQuestionUseCase } from './update-question.use-case';

const q = (overrides: Partial<QuestionModel> = {}): QuestionModel =>
  new QuestionModel(
    overrides.id ?? 'q-1',
    overrides.tenantId ?? 't-1',
    overrides.createdBy ?? 'teacher-1',
    overrides.sourceUploadId ?? null,
    overrides.type ?? QuestionType.SINGLE_CHOICE,
    overrides.payload ?? {},
    overrides.programId ?? null,
    overrides.subjectId ?? null,
    overrides.topicId ?? null,
    overrides.chapterId ?? null,
    overrides.subject ?? null,
    overrides.topic ?? null,
    overrides.difficulty ?? Difficulty.MEDIUM,
    overrides.isActive ?? true,
    new Date(),
    new Date(),
  );

describe('UpdateQuestionUseCase', () => {
  let repo: jest.Mocked<IQuestionRepository>;
  let useCase: UpdateQuestionUseCase;

  beforeEach(() => {
    repo = {
      create: jest.fn(),
      findById: jest.fn(),
      list: jest.fn(),
      update: jest
        .fn()
        .mockImplementation(async (_t, id) => ({ question: q({ id }), options: [] })),
      softDelete: jest.fn(),
      countActive: jest.fn(),
    };
    const taxonomy = {
      resolve: jest
        .fn()
        .mockResolvedValue({ program: null, subject: null, topic: null, chapter: null }),
    } as unknown as TaxonomyResolverService;
    useCase = new UpdateQuestionUseCase(repo, new QuestionPayloadValidator(), taxonomy);
  });

  it('TEACHER can edit own question', async () => {
    repo.findById.mockResolvedValue({ question: q(), options: [] });
    const r = await useCase.execute({
      actor: { sub: 'teacher-1', tenantId: 't-1', branchId: 'b', role: Role.TEACHER },
      id: 'q-1',
      subject: 'Maths',
    });
    expect(r.question.id).toBe('q-1');
  });

  it('TEACHER cannot edit someone else question', async () => {
    repo.findById.mockResolvedValue({ question: q({ createdBy: 'other' }), options: [] });
    await expect(
      useCase.execute({
        actor: { sub: 'teacher-1', tenantId: 't-1', branchId: 'b', role: Role.TEACHER },
        id: 'q-1',
        subject: 'X',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws 404 on missing', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(
      useCase.execute({
        actor: { sub: 'teacher-1', tenantId: 't-1', branchId: 'b', role: Role.TEACHER },
        id: 'q-1',
        subject: 'X',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 400 when no fields supplied', async () => {
    repo.findById.mockResolvedValue({ question: q(), options: [] });
    await expect(
      useCase.execute({
        actor: { sub: 'teacher-1', tenantId: 't-1', branchId: 'b', role: Role.TEACHER },
        id: 'q-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('validates new payload against existing options', async () => {
    repo.findById.mockResolvedValue({
      question: q({ type: QuestionType.SINGLE_CHOICE }),
      options: [
        new QuestionOptionModel('o1', 't-1', 'q-1', 'A', true, 0),
        new QuestionOptionModel('o2', 't-1', 'q-1', 'B', false, 1),
      ],
    });
    await expect(
      useCase.execute({
        actor: { sub: 'teacher-1', tenantId: 't-1', branchId: 'b', role: Role.TEACHER },
        id: 'q-1',
        options: [
          { label: 'A', isCorrect: true },
          { label: 'B', isCorrect: true }, // two corrects → invalid for SINGLE_CHOICE
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
