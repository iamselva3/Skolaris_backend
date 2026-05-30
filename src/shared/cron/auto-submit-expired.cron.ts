import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  EXAM_ATTEMPT_REPOSITORY,
  IExamAttemptRepository,
} from '../../modules/attempts/repositories/exam-attempt.repository';
import { GradeAttemptUseCase } from '../../modules/attempts/use-cases/grade-attempt.use-case';

@Injectable()
export class AutoSubmitExpiredCron {
  private readonly logger = new Logger(AutoSubmitExpiredCron.name);

  constructor(
    @Inject(EXAM_ATTEMPT_REPOSITORY) private readonly attempts: IExamAttemptRepository,
    private readonly grader: GradeAttemptUseCase,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run(): Promise<void> {
    const expired = await this.attempts.findExpiredInProgress(new Date());
    if (expired.length === 0) return;
    for (const a of expired) {
      try {
        await this.attempts.submit({
          tenantId: a.tenantId,
          id: a.id,
          autoSubmitted: true,
        });
        await this.grader.execute({ tenantId: a.tenantId, attemptId: a.id });
      } catch (err) {
        this.logger.warn(
          `Auto-submit failed for attempt ${a.id}: ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(`Auto-submitted ${expired.length} expired attempt(s)`);
  }
}
