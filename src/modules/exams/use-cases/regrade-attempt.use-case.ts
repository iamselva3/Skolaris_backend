import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import {
  GradeAttemptUseCase,
  GradeAttemptResult,
} from '../../attempts/use-cases/grade-attempt.use-case';
import {
  EXAM_ATTEMPT_REPOSITORY,
  IExamAttemptRepository,
} from '../../attempts/repositories/exam-attempt.repository';
import { EXAM_REPOSITORY, IExamRepository } from '../repositories/exam.repository';

@Injectable()
export class RegradeAttemptUseCase {
  constructor(
    @Inject(EXAM_REPOSITORY) private readonly exams: IExamRepository,
    @Inject(EXAM_ATTEMPT_REPOSITORY) private readonly attempts: IExamAttemptRepository,
    private readonly grader: GradeAttemptUseCase,
  ) {}

  async execute(input: {
    actor: AuthenticatedUser;
    examId: string;
    attemptId: string;
  }): Promise<GradeAttemptResult> {
    const exam = await this.exams.findById(input.actor.tenantId, input.examId);
    if (!exam) throw new NotFoundException('Exam not found');
    if (input.actor.role === Role.TEACHER && exam.createdBy !== input.actor.sub) {
      throw new ForbiddenException('Teachers can only regrade exams they created');
    }
    const attempt = await this.attempts.findById(input.actor.tenantId, input.attemptId);
    if (!attempt || attempt.examId !== input.examId) {
      throw new NotFoundException('Attempt not found');
    }
    if (attempt.status === 'NOT_STARTED' || attempt.status === 'IN_PROGRESS') {
      throw new ConflictException('Cannot regrade an attempt that has not been submitted');
    }
    return this.grader.execute({
      tenantId: input.actor.tenantId,
      attemptId: input.attemptId,
    });
  }
}
