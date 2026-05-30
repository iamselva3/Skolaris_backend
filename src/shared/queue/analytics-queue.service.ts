import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { queueConfig } from '../config/queue.config';
import { createRedisConnection } from './bullmq.config';

export interface AnalyticsAggregateJob {
  attemptId: string;
  tenantId: string;
}

@Injectable()
export class AnalyticsQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(AnalyticsQueueService.name);
  private readonly connection: Redis;
  private readonly queue: Queue<AnalyticsAggregateJob>;

  constructor(@Inject(queueConfig.KEY) private readonly cfg: ConfigType<typeof queueConfig>) {
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

  async enqueue(job: AnalyticsAggregateJob): Promise<string> {
    const added = await this.queue.add('aggregate', job, { jobId: job.attemptId });
    this.logger.log(`Enqueued analytics job for attempt ${job.attemptId}`);
    return added.id ?? job.attemptId;
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
