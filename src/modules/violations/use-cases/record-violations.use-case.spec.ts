import { ForbiddenException } from '@nestjs/common';
import { ExamAttemptModel } from '../../attempts/models/exam-attempt.model';
import { IExamAttemptRepository } from '../../attempts/repositories/exam-attempt.repository';
import { GradeAttemptUseCase } from '../../attempts/use-cases/grade-attempt.use-case';
import { IViolationRepository } from '../repositories/violation.repository';
import { RecordViolationsUseCase } from './record-violations.use-case';

const fakePrisma = {
  $transaction: async <T>(cb: () => Promise<T>) => cb(),
  exam: {
    findUniqueOrThrow: jest.fn().mockResolvedValue({
      antiCheatConfig: {
        tabSwitchThreshold: 3,
        totalViolationThreshold: 10,
        flagAtViolationCount: 5,
      },
    }),
  },
} as unknown as import('../../../shared/database/prisma.service').PrismaService;

const attempt = (overrides: Partial<ExamAttemptModel> = {}): ExamAttemptModel =>
  new ExamAttemptModel(
    overrides.id ?? 'a-1',
    overrides.tenantId ?? 't-1',
    overrides.examId ?? 'e-1',
    overrides.studentId ?? 's-1',
    overrides.status ?? 'IN_PROGRESS',
    new Date(),
    null,
    null,
    600,
    null,
    false,
    BigInt(1),
    overrides.violationCount ?? 0,
    false,
    new Date(),
    new Date(),
  );

describe('RecordViolationsUseCase', () => {
  let violations: jest.Mocked<IViolationRepository>;
  let attempts: jest.Mocked<IExamAttemptRepository>;
  let grader: jest.Mocked<GradeAttemptUseCase>;
  let useCase: RecordViolationsUseCase;

  beforeEach(() => {
    violations = {
      bulkCreate: jest.fn().mockResolvedValue(1),
      countByAttempt: jest.fn(),
      countByAttemptAndType: jest.fn(),
      listByAttempt: jest.fn(),
    };
    attempts = {
      bulkCreate: jest.fn(),
      findById: jest.fn(),
      findByIdAnyTenant: jest.fn(),
      findByExamAndStudent: jest.fn(),
      list: jest.fn(),
      listForStudent: jest.fn(),
      start: jest.fn(),
      saveProgress: jest.fn(),
      submit: jest.fn().mockResolvedValue(attempt({ status: 'SUBMITTED' })),
      setStatus: jest.fn().mockResolvedValue(attempt()),
      setGradedScore: jest.fn(),
      incrementViolationCount: jest
        .fn()
        .mockImplementation(async (_, __, delta) => attempt({ violationCount: delta })),
      findExpiredInProgress: jest.fn(),
      upsertAnswer: jest.fn(),
      listAnswers: jest.fn(),
      updateAnswerGrading: jest.fn(),
    };
    grader = { execute: jest.fn() } as unknown as jest.Mocked<GradeAttemptUseCase>;
    useCase = new RecordViolationsUseCase(violations, attempts, fakePrisma, grader);
  });

  it('inserts events and bumps the counter', async () => {
    attempts.findById.mockResolvedValue(attempt({ violationCount: 0 }));
    attempts.incrementViolationCount.mockResolvedValue(attempt({ violationCount: 1 }));
    violations.countByAttemptAndType.mockResolvedValue(0);

    const r = await useCase.execute({
      tenantId: 't-1',
      studentId: 's-1',
      attemptId: 'a-1',
      events: [{ type: 'COPY_ATTEMPT', clientTimestamp: new Date() }],
    });
    expect(violations.bulkCreate).toHaveBeenCalled();
    expect(r.autoSubmitted).toBe(false);
    expect(r.flagged).toBe(false);
  });

  it('flags the attempt at flagAtViolationCount', async () => {
    attempts.findById.mockResolvedValue(attempt({ violationCount: 4 }));
    attempts.incrementViolationCount.mockResolvedValue(attempt({ violationCount: 5 }));
    violations.countByAttemptAndType.mockResolvedValue(0);

    const r = await useCase.execute({
      tenantId: 't-1',
      studentId: 's-1',
      attemptId: 'a-1',
      events: [{ type: 'WINDOW_BLUR', clientTimestamp: new Date() }],
    });
    expect(r.flagged).toBe(true);
    expect(attempts.setStatus).toHaveBeenCalledWith('t-1', 'a-1', 'FLAGGED');
  });

  it('auto-submits + grades at totalViolationThreshold', async () => {
    attempts.findById.mockResolvedValue(attempt({ violationCount: 9 }));
    attempts.incrementViolationCount.mockResolvedValue(attempt({ violationCount: 10 }));
    violations.countByAttemptAndType.mockResolvedValue(0);

    const r = await useCase.execute({
      tenantId: 't-1',
      studentId: 's-1',
      attemptId: 'a-1',
      events: [{ type: 'COPY_ATTEMPT', clientTimestamp: new Date() }],
    });
    expect(r.autoSubmitted).toBe(true);
    expect(attempts.submit).toHaveBeenCalledWith({
      tenantId: 't-1',
      id: 'a-1',
      autoSubmitted: true,
    });
    expect(grader.execute).toHaveBeenCalled();
  });

  it('auto-submits at tabSwitchThreshold even when total is lower', async () => {
    attempts.findById.mockResolvedValue(attempt({ violationCount: 2 }));
    attempts.incrementViolationCount.mockResolvedValue(attempt({ violationCount: 3 }));
    violations.countByAttemptAndType.mockResolvedValue(3);

    const r = await useCase.execute({
      tenantId: 't-1',
      studentId: 's-1',
      attemptId: 'a-1',
      events: [{ type: 'TAB_SWITCH', clientTimestamp: new Date() }],
    });
    expect(r.autoSubmitted).toBe(true);
  });

  it('forbids non-owner', async () => {
    attempts.findById.mockResolvedValue(attempt({ studentId: 'other' }));
    await expect(
      useCase.execute({
        tenantId: 't-1',
        studentId: 's-1',
        attemptId: 'a-1',
        events: [{ type: 'COPY_ATTEMPT', clientTimestamp: new Date() }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
