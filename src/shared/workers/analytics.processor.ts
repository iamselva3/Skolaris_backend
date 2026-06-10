import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { queueConfig } from '../config/queue.config';
import { AnalyticsAggregateJob } from '../queue/analytics-queue.service';
import { createRedisConnection } from '../queue/bullmq.config';
import { AnalyticsJobRunner } from './analytics-job-runner.service';

/**
 * BullMQ analytics consumer for QUEUE_DRIVER=redis. When QUEUE_DRIVER=inline it
 * is inert — aggregation runs via InlineAnalyticsDispatcher with no Redis. The
 * job body lives in AnalyticsJobRunner (shared with the inline dispatcher).
 */
@Injectable()
export class AnalyticsProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnalyticsProcessor.name);
  private connection?: Redis;
  private worker?: Worker<AnalyticsAggregateJob>;

  constructor(
    @Inject(queueConfig.KEY) private readonly cfg: ConfigType<typeof queueConfig>,
    private readonly runner: AnalyticsJobRunner,
  ) {}

  onModuleInit(): void {
    if (this.cfg.queueDriver === 'inline') {
      this.logger.log(
        'BullMQ analytics worker disabled (QUEUE_DRIVER=inline); aggregation runs in-process — no Redis.',
      );
      return;
    }

    this.connection = createRedisConnection(this.cfg.redisUrl);
    this.worker = new Worker<AnalyticsAggregateJob>(
      this.cfg.analyticsQueueName,
      async (job) => {
        await this.runner.run(job.data, String(job.id ?? job.data.attemptId));
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
