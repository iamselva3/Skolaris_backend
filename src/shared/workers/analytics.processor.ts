import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { queueConfig } from '../config/queue.config';
import { PrismaService } from '../database/prisma.service';
import { RecomputeQuestionStatsUseCase } from '../../modules/analytics/use-cases/recompute-question-stats.use-case';
import { RecomputeTopicReportsForStudentUseCase } from '../../modules/analytics/use-cases/recompute-topic-reports.use-case';
import { AnalyticsAggregateJob } from '../queue/analytics-queue.service';
import { createRedisConnection } from '../queue/bullmq.config';

/**
 * Worker that runs inside the API process. For Phase 3 this keeps deployment
 * simple — a separate worker process is a Phase 4 concern.
 *
 * On each completed attempt, recompute QuestionStat for every question the
 * student touched and TopicReport rollups for the student. Idempotent.
 */
@Injectable()
export class AnalyticsProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnalyticsProcessor.name);
  private connection!: Redis;
  private worker!: Worker<AnalyticsAggregateJob>;

  constructor(
    @Inject(queueConfig.KEY) private readonly cfg: ConfigType<typeof queueConfig>,
    private readonly prisma: PrismaService,
    private readonly recomputeQuestionStats: RecomputeQuestionStatsUseCase,
    private readonly recomputeTopicReports: RecomputeTopicReportsForStudentUseCase,
  ) {}

  onModuleInit(): void {
    this.connection = createRedisConnection(this.cfg.redisUrl);
    this.worker = new Worker<AnalyticsAggregateJob>(
      this.cfg.analyticsQueueName,
      async (job) => {
        const { attemptId, tenantId } = job.data;
        const attempt = await this.prisma.examAttempt.findFirst({
          where: { id: attemptId, tenantId },
          select: {
            studentId: true,
            answers: { select: { examQuestion: { select: { questionId: true } } } },
          },
        });
        if (!attempt) {
          this.logger.warn(`Analytics job ${job.id}: attempt ${attemptId} not found`);
          return;
        }
        const questionIds = Array.from(
          new Set(attempt.answers.map((a) => a.examQuestion.questionId)),
        );
        for (const qid of questionIds) {
          await this.recomputeQuestionStats.execute({ tenantId, questionId: qid });
        }
        const touched = await this.recomputeTopicReports.execute({
          tenantId,
          studentId: attempt.studentId,
        });
        this.logger.log(
          `Analytics job ${job.id}: recomputed ${questionIds.length} question(s), ${touched} topic(s) for student ${attempt.studentId}`,
        );
      },
      { connection: this.connection, concurrency: 4 },
    );
    this.worker.on('failed', (job, err) =>
      this.logger.error(`Analytics job ${job?.id} failed: ${err.message}`),
    );
    this.logger.log(`AnalyticsProcessor consuming "${this.cfg.analyticsQueueName}"`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) await this.worker.close();
    if (this.connection) await this.connection.quit();
  }
}
