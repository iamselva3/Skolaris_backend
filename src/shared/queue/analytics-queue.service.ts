import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { queueConfig } from '../config/queue.config';
import { createRedisConnection } from './bullmq.config';
import { IAnalyticsDispatcher } from './analytics-dispatcher';

export interface AnalyticsAggregateJob {
  attemptId: string;
  tenantId: string;
}

/**
 * BullMQ producer for analytics aggregation — the 'redis' AnalyticsDispatcher.
 * LAZY: connection + Queue are created on first enqueue(), so under
 * QUEUE_DRIVER=inline this service opens NO Redis connection (the inline
 * dispatcher is used instead). Mirrors OcrQueueService.
 */
@Injectable()
export class AnalyticsQueueService implements OnModuleDestroy, IAnalyticsDispatcher {
  private readonly logger = new Logger(AnalyticsQueueService.name);
  private connection: Redis | null = null;
  private queue: Queue<AnalyticsAggregateJob> | null = null;

  constructor(@Inject(queueConfig.KEY) private readonly cfg: ConfigType<typeof queueConfig>) {}

  private ensureQueue(): Queue<AnalyticsAggregateJob> {
    if (!this.queue) {
      this.connection = createRedisConnection(this.cfg.redisUrl);
      this.queue = new Queue<AnalyticsAggregateJob>(this.cfg.analyticsQueueName, {
        connection: this.connection,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { age: 60 * 60 * 24, count: 500 },
          removeOnFail: { age: 7 * 24 * 60 * 60 },
        },
      });
    }
    return this.queue;
  }

  async enqueue(job: AnalyticsAggregateJob): Promise<string> {
    const added = await this.ensureQueue().add('aggregate', job, { jobId: job.attemptId });
    this.logger.log(`Enqueued analytics job for attempt ${job.attemptId}`);
    return added.id ?? job.attemptId;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.queue) await this.queue.close();
    if (this.connection) await this.connection.quit();
  }
}
