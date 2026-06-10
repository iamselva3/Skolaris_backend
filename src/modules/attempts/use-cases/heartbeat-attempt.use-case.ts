import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../shared/database/prisma.service';
import {
  EXAM_ATTEMPT_REPOSITORY,
  IExamAttemptRepository,
} from '../repositories/exam-attempt.repository';
import { GradeAttemptUseCase } from './grade-attempt.use-case';

export interface HeartbeatResult {
  serverTimeRemainingSeconds: number;
  autoSubmitted: boolean;
}

@Injectable()
export class HeartbeatAttemptUseCase {
  constructor(
    @Inject(EXAM_ATTEMPT_REPOSITORY) private readonly attempts: IExamAttemptRepository,
    private readonly prisma: PrismaService,
    private readonly grader: GradeAttemptUseCase,
  ) {}

  async execute(input: {
    tenantId: string;
    studentId: string;
    attemptId: string;
    clientTimeRemainingSeconds: number;
  }): Promise<HeartbeatResult> {
    const attempt = await this.attempts.findById(input.tenantId, input.attemptId);
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (attempt.studentId !== input.studentId) {
      throw new ForbiddenException('Not your attempt');
    }
    if (attempt.status !== 'IN_PROGRESS') {
      throw new ConflictException('Attempt is not in progress');
    }
    const exam = await this.prisma.exam.findUniqueOrThrow({ where: { id: attempt.examId } });
    if (!attempt.startedAt) {
      throw new ConflictException('Attempt has no startedAt — cannot compute time');
    }
    const elapsedSeconds = Math.floor((Date.now() - attempt.startedAt.getTime()) / 1000);
    const serverRemaining = Math.max(0, exam.durationSeconds - elapsedSeconds);
    // Use the lower of (server-authoritative remaining) and (client-reported) — defensive.
    const remaining = Math.min(serverRemaining, input.clientTimeRemainingSeconds);

    if (serverRemaining <= 0) {
      await this.attempts.submit({
        tenantId: input.tenantId,
        id: attempt.id,
        autoSubmitted: true,
      });
      await this.grader.execute({ tenantId: input.tenantId, attemptId: attempt.id });
      return { serverTimeRemainingSeconds: 0, autoSubmitted: true };
    }

    await this.attempts.saveProgress({
      tenantId: input.tenantId,
      id: attempt.id,
      timeRemainingSeconds: remaining,
    });
    return { serverTimeRemainingSeconds: serverRemaining, autoSubmitted: false };
  }
}
