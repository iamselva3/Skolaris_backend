import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ExamAttemptModel } from '../models/exam-attempt.model';
import {
  EXAM_ATTEMPT_REPOSITORY,
  IExamAttemptRepository,
} from '../repositories/exam-attempt.repository';
import { GradeAttemptUseCase } from './grade-attempt.use-case';

@Injectable()
export class SubmitAttemptUseCase {
  constructor(
    @Inject(EXAM_ATTEMPT_REPOSITORY) private readonly attempts: IExamAttemptRepository,
    private readonly grader: GradeAttemptUseCase,
  ) {}

  async execute(input: {
    tenantId: string;
    studentId: string;
    attemptId: string;
    autoSubmitted?: boolean;
  }): Promise<ExamAttemptModel> {
    const attempt = await this.attempts.findById(input.tenantId, input.attemptId);
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (attempt.studentId !== input.studentId) {
      throw new ForbiddenException('Not your attempt');
    }
    if (attempt.status === 'SUBMITTED' || attempt.status === 'GRADED') {
      throw new ConflictException('Attempt already submitted');
    }
    if (attempt.status === 'NOT_STARTED') {
      throw new ConflictException('Attempt has not been started');
    }
    const submitted = await this.attempts.submit({
      tenantId: input.tenantId,
      id: attempt.id,
      autoSubmitted: input.autoSubmitted,
    });
    // Inline grading (synchronous). Grading is fast for objective types.
    await this.grader.execute({ tenantId: input.tenantId, attemptId: attempt.id });
    return submitted;
  }
}
