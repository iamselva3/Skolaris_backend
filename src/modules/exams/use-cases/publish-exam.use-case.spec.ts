import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { DEFAULT_ANTI_CHEAT_CONFIG, ExamModel } from '../models/exam.model';
import { Decimal } from '@prisma/client/runtime/library';
import { ExamSectionModel } from '../models/exam-section.model';
import { ExamQuestionModel } from '../models/exam-question.model';
import { ExamAssignmentModel } from '../models/exam-assignment.model';
import { IExamRepository } from '../repositories/exam.repository';
import { IExamAttemptRepository } from '../../attempts/repositories/exam-attempt.repository';
import { CreateNotificationUseCase } from '../../notifications/use-cases/create-notification.use-case';
import { PublishExamUseCase } from './publish-exam.use-case';

const fakePrisma = {
  $transaction: async <T>(cb: () => Promise<T>) => cb(),
  student: {
    findMany: jest.fn().mockResolvedValue([
      { id: 's-1', user: { id: 'u-1', name: 'A' } },
      { id: 's-2', user: { id: 'u-2', name: 'B' } },
    ]),
  },
} as unknown as import('../../../shared/database/prisma.service').PrismaService;

const baseExam = (overrides: Partial<ExamModel> = {}): ExamModel =>
  new ExamModel(
    overrides.id ?? 'e-1',
    overrides.tenantId ?? 't-1',
    overrides.createdBy ?? 'teacher-1',
    'Quiz',
    null,
    1800,
    new Decimal(0),
    new Decimal(0),
    false,
    false,
    overrides.status ?? 'DRAFT',
    overrides.opensAt ?? null,
    overrides.closesAt ?? null,
    'ONLINE',
    null,
    DEFAULT_ANTI_CHEAT_CONFIG,
    overrides.programId ?? null,
    overrides.subjectId ?? null,
    new Date(),
    new Date(),
  );

describe('PublishExamUseCase', () => {
  let exams: jest.Mocked<IExamRepository>;
  let attempts: jest.Mocked<IExamAttemptRepository>;
  let notifications: jest.Mocked<CreateNotificationUseCase>;
  let useCase: PublishExamUseCase;

  beforeEach(() => {
    exams = {
      create: jest.fn(),
      findById: jest.fn(),
      findByIdAnyTenant: jest.fn(),
      findDetail: jest.fn().mockResolvedValue({
        exam: baseExam({ status: 'DRAFT' }),
        sections: [] as ExamSectionModel[],
        questions: [
          new ExamQuestionModel('eq-1', 't-1', 'e-1', null, 'q-1', 0, new Decimal(2), new Decimal(0)),
        ] as ExamQuestionModel[],
        assignments: [
          new ExamAssignmentModel('asg-1', 't-1', 'e-1', 'c-1', null),
        ] as ExamAssignmentModel[],
      }),
      list: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      setStatus: jest.fn().mockImplementation(async (_t, _id, status) => baseExam({ status })),
      recomputeTotalMarks: jest.fn(),
      createSection: jest.fn(),
      updateSection: jest.fn(),
      deleteSection: jest.fn(),
      addExamQuestions: jest.fn(),
      updateExamQuestion: jest.fn(),
      removeExamQuestion: jest.fn(),
      createAssignments: jest.fn(),
      expandAssignmentsToStudentIds: jest.fn().mockResolvedValue(['s-1', 's-2']),
    };
    attempts = {
      bulkCreate: jest.fn().mockResolvedValue(2),
    } as unknown as jest.Mocked<IExamAttemptRepository>;
    notifications = { execute: jest.fn() } as unknown as jest.Mocked<CreateNotificationUseCase>;
    useCase = new PublishExamUseCase(exams, attempts, notifications, fakePrisma);
  });

  it('publishes a DRAFT exam, creates attempts + notifications', async () => {
    const r = await useCase.execute({
      actor: { sub: 'teacher-1', tenantId: 't-1', branchId: null, role: Role.TEACHER },
      examId: 'e-1',
    });
    expect(r.attemptsCreated).toBe(2);
    expect(attempts.bulkCreate).toHaveBeenCalledWith({
      tenantId: 't-1',
      examId: 'e-1',
      studentIds: ['s-1', 's-2'],
    });
    // 2 notifications per student (in-app + email)
    expect(notifications.execute).toHaveBeenCalledTimes(4);
    expect(exams.setStatus).toHaveBeenCalledWith('t-1', 'e-1', 'SCHEDULED', expect.any(Date));
  });

  it('transitions immediately to LIVE if opensAt is past', async () => {
    exams.findDetail.mockResolvedValueOnce({
      exam: baseExam({ opensAt: new Date(Date.now() - 60_000) }),
      sections: [],
      questions: [new ExamQuestionModel('eq-1', 't-1', 'e-1', null, 'q-1', 0, new Decimal(2), new Decimal(0))],
      assignments: [new ExamAssignmentModel('asg-1', 't-1', 'e-1', 'c-1', null)],
    });
    await useCase.execute({
      actor: { sub: 'teacher-1', tenantId: 't-1', branchId: null, role: Role.TEACHER },
      examId: 'e-1',
    });
    expect(exams.setStatus).toHaveBeenCalledWith('t-1', 'e-1', 'LIVE', expect.any(Date));
  });

  it('forbids TEACHER publishing another teacher\'s exam', async () => {
    exams.findDetail.mockResolvedValue({
      exam: baseExam({ createdBy: 'other' }),
      sections: [],
      questions: [new ExamQuestionModel('eq-1', 't-1', 'e-1', null, 'q-1', 0, new Decimal(2), new Decimal(0))],
      assignments: [new ExamAssignmentModel('asg-1', 't-1', 'e-1', 'c-1', null)],
    });
    await expect(
      useCase.execute({
        actor: { sub: 'teacher-1', tenantId: 't-1', branchId: null, role: Role.TEACHER },
        examId: 'e-1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects publishing an exam with no questions', async () => {
    exams.findDetail.mockResolvedValueOnce({
      exam: baseExam(),
      sections: [],
      questions: [],
      assignments: [new ExamAssignmentModel('asg-1', 't-1', 'e-1', 'c-1', null)],
    });
    await expect(
      useCase.execute({
        actor: { sub: 'teacher-1', tenantId: 't-1', branchId: null, role: Role.TEACHER },
        examId: 'e-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects publishing a non-DRAFT exam', async () => {
    exams.findDetail.mockResolvedValueOnce({
      exam: baseExam({ status: 'LIVE' }),
      sections: [],
      questions: [new ExamQuestionModel('eq-1', 't-1', 'e-1', null, 'q-1', 0, new Decimal(2), new Decimal(0))],
      assignments: [new ExamAssignmentModel('asg-1', 't-1', 'e-1', 'c-1', null)],
    });
    await expect(
      useCase.execute({
        actor: { sub: 'teacher-1', tenantId: 't-1', branchId: null, role: Role.TEACHER },
        examId: 'e-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
