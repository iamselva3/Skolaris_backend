import { Inject, Injectable } from '@nestjs/common';
import {
  EXAM_ATTEMPT_REPOSITORY,
  IExamAttemptRepository,
} from '../../attempts/repositories/exam-attempt.repository';
import { ExamAttemptModel } from '../../attempts/models/exam-attempt.model';

@Injectable()
export class ListExamAttemptsUseCase {
  constructor(
    @Inject(EXAM_ATTEMPT_REPOSITORY) private readonly attempts: IExamAttemptRepository,
  ) {}

  async execute(input: {
    tenantId: string;
    examId: string;
    limit: number;
    offset: number;
  }): Promise<{ data: ExamAttemptModel[]; total: number }> {
    return this.attempts.list({
      tenantId: input.tenantId,
      examId: input.examId,
      limit: input.limit,
      offset: input.offset,
    });
  }
}
