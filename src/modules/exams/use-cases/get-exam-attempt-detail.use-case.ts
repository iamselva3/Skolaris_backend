import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AttemptAnswerModel } from '../../attempts/models/attempt-answer.model';
import { ExamAttemptModel } from '../../attempts/models/exam-attempt.model';
import {
  EXAM_ATTEMPT_REPOSITORY,
  IExamAttemptRepository,
} from '../../attempts/repositories/exam-attempt.repository';
import { ViolationModel } from '../../violations/models/violation.model';
import {
  IViolationRepository,
  VIOLATION_REPOSITORY,
} from '../../violations/repositories/violation.repository';

export interface ExamAttemptDetail {
  attempt: ExamAttemptModel;
  answers: AttemptAnswerModel[];
  violations: ViolationModel[];
}

@Injectable()
export class GetExamAttemptDetailUseCase {
  constructor(
    @Inject(EXAM_ATTEMPT_REPOSITORY) private readonly attempts: IExamAttemptRepository,
    @Inject(VIOLATION_REPOSITORY) private readonly violations: IViolationRepository,
  ) {}

  async execute(input: {
    tenantId: string;
    examId: string;
    attemptId: string;
  }): Promise<ExamAttemptDetail> {
    const attempt = await this.attempts.findById(input.tenantId, input.attemptId);
    if (!attempt || attempt.examId !== input.examId) {
      throw new NotFoundException('Attempt not found');
    }
    const [answers, violations] = await Promise.all([
      this.attempts.listAnswers(input.tenantId, input.attemptId),
      this.violations.listByAttempt(input.tenantId, input.attemptId),
    ]);
    return { attempt, answers, violations };
  }
}
