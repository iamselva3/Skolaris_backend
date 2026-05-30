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
  EXAM_ATTEMPT_REPOSITORY,
  IExamAttemptRepository,
} from '../../attempts/repositories/exam-attempt.repository';
import {
  ANALYTICS_DISPATCHER,
  IAnalyticsDispatcher,
} from '../../../shared/queue/analytics-dispatcher';
import { ExamModel } from '../models/exam.model';
import { EXAM_REPOSITORY, IExamRepository } from '../repositories/exam.repository';

export interface CloseExamResult {
  exam: ExamModel;
  attemptsAutoSubmitted: number;
}

@Injectable()
export class CloseExamUseCase {
  constructor(
    @Inject(EXAM_REPOSITORY) private readonly exams: IExamRepository,
    @Inject(EXAM_ATTEMPT_REPOSITORY) private readonly attempts: IExamAttemptRepository,
    @Inject(ANALYTICS_DISPATCHER) private readonly analyticsQueue: IAnalyticsDispatcher,
  ) {}

  async execute(input: { actor: AuthenticatedUser; examId: string }): Promise<CloseExamResult> {
    const exam = await this.exams.findById(input.actor.tenantId, input.examId);
    if (!exam) throw new NotFoundException('Exam not found');
    if (input.actor.role === Role.TEACHER && exam.createdBy !== input.actor.sub) {
      throw new ForbiddenException('Teachers can only close exams they created');
    }
    if (exam.status === 'CLOSED' || exam.status === 'DRAFT') {
      throw new ConflictException(`Exam is in status ${exam.status}; cannot close`);
    }

    const { data: lingering } = await this.attempts.list({
      tenantId: input.actor.tenantId,
      examId: input.examId,
      status: 'IN_PROGRESS',
      limit: 1000,
    });
    let autoSubmitted = 0;
    for (const a of lingering) {
      await this.attempts.submit({ tenantId: a.tenantId, id: a.id, autoSubmitted: true });
      await this.analyticsQueue.enqueue({ attemptId: a.id, tenantId: a.tenantId });
      autoSubmitted += 1;
    }
    const updated = await this.exams.setStatus(input.actor.tenantId, input.examId, 'CLOSED');
    return { exam: updated, attemptsAutoSubmitted: autoSubmitted };
  }
}
