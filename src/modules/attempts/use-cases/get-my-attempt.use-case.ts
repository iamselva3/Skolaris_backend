import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AttemptAnswerModel } from '../models/attempt-answer.model';
import { ExamAttemptModel } from '../models/exam-attempt.model';
import {
  EXAM_ATTEMPT_REPOSITORY,
  IExamAttemptRepository,
} from '../repositories/exam-attempt.repository';

export interface MyAttemptDetail {
  attempt: ExamAttemptModel;
  answers: AttemptAnswerModel[];
}

@Injectable()
export class GetMyAttemptUseCase {
  constructor(@Inject(EXAM_ATTEMPT_REPOSITORY) private readonly attempts: IExamAttemptRepository) {}

  async execute(input: {
    tenantId: string;
    studentId: string;
    attemptId: string;
  }): Promise<MyAttemptDetail> {
    const attempt = await this.attempts.findById(input.tenantId, input.attemptId);
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (attempt.studentId !== input.studentId) {
      throw new ForbiddenException('Not your attempt');
    }
    const answers = await this.attempts.listAnswers(input.tenantId, input.attemptId);
    return { attempt, answers };
  }
}
