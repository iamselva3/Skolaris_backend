import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { RecomputeQuestionStatsUseCase } from '../../modules/analytics/use-cases/recompute-question-stats.use-case';
import { RecomputeTopicReportsForStudentUseCase } from '../../modules/analytics/use-cases/recompute-topic-reports.use-case';
import { AnalyticsAggregateJob } from '../queue/analytics-queue.service';

/**
 * The analytics aggregation body, extracted VERBATIM from AnalyticsProcessor's
 * BullMQ worker callback so a single implementation backs BOTH backends:
 *   - the BullMQ worker (AnalyticsProcessor, QUEUE_DRIVER=redis)
 *   - the in-process dispatcher (InlineAnalyticsDispatcher, QUEUE_DRIVER=inline)
 *
 * Recompute logic is unchanged and idempotent.
 */
@Injectable()
export class AnalyticsJobRunner {
  private readonly logger = new Logger(AnalyticsJobRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly recomputeQuestionStats: RecomputeQuestionStatsUseCase,
    private readonly recomputeTopicReports: RecomputeTopicReportsForStudentUseCase,
  ) {}

  async run(job: AnalyticsAggregateJob, label = job.attemptId): Promise<void> {
    const { attemptId, tenantId } = job;
    const attempt = await this.prisma.examAttempt.findFirst({
      where: { id: attemptId, tenantId },
      select: {
        studentId: true,
        answers: { select: { examQuestion: { select: { questionId: true } } } },
      },
    });
    if (!attempt) {
      this.logger.warn(`Analytics job ${label}: attempt ${attemptId} not found`);
      return;
    }
    const questionIds = Array.from(new Set(attempt.answers.map((a) => a.examQuestion.questionId)));
    for (const qid of questionIds) {
      await this.recomputeQuestionStats.execute({ tenantId, questionId: qid });
    }
    const touched = await this.recomputeTopicReports.execute({
      tenantId,
      studentId: attempt.studentId,
    });
    this.logger.log(
      `Analytics job ${label}: recomputed ${questionIds.length} question(s), ${touched} topic(s) for student ${attempt.studentId}`,
    );
  }
}
