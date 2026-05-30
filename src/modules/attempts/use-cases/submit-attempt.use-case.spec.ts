import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ExamAttemptModel } from '../models/exam-attempt.model';
import { IExamAttemptRepository } from '../repositories/exam-attempt.repository';
import { GradeAttemptUseCase } from './grade-attempt.use-case';
import { SubmitAttemptUseCase } from './submit-attempt.use-case';

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
    0,
    false,
    new Date(),
    new Date(),
  );

describe('SubmitAttemptUseCase', () => {
  let attempts: jest.Mocked<IExamAttemptRepository>;
  let grader: jest.Mocked<GradeAttemptUseCase>;
  let useCase: SubmitAttemptUseCase;

  beforeEach(() => {
    attempts = {
      findById: jest.fn(),
      submit: jest.fn().mockResolvedValue(attempt({ status: 'SUBMITTED' })),
    } as unknown as jest.Mocked<IExamAttemptRepository>;
    grader = { execute: jest.fn() } as unknown as jest.Mocked<GradeAttemptUseCase>;
    useCase = new SubmitAttemptUseCase(attempts, grader);
  });

  it('submits and grades on happy path', async () => {
    attempts.findById.mockResolvedValue(attempt());
    await useCase.execute({ tenantId: 't-1', studentId: 's-1', attemptId: 'a-1' });
    expect(attempts.submit).toHaveBeenCalled();
    expect(grader.execute).toHaveBeenCalledWith({ tenantId: 't-1', attemptId: 'a-1' });
  });

  it('throws 404 when attempt missing', async () => {
    attempts.findById.mockResolvedValue(null);
    await expect(
      useCase.execute({ tenantId: 't-1', studentId: 's-1', attemptId: 'a-1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('forbids non-owner', async () => {
    attempts.findById.mockResolvedValue(attempt({ studentId: 'other' }));
    await expect(
      useCase.execute({ tenantId: 't-1', studentId: 's-1', attemptId: 'a-1' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects double-submit', async () => {
    attempts.findById.mockResolvedValue(attempt({ status: 'SUBMITTED' }));
    await expect(
      useCase.execute({ tenantId: 't-1', studentId: 's-1', attemptId: 'a-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects submit on NOT_STARTED', async () => {
    attempts.findById.mockResolvedValue(attempt({ status: 'NOT_STARTED' }));
    await expect(
      useCase.execute({ tenantId: 't-1', studentId: 's-1', attemptId: 'a-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
