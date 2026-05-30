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

export interface NotificationsDispatchJob {
  // No payload — the worker queries the DB for unsent rows.
  enqueuedAt: number;
}

@Injectable()
export class NotificationsQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationsQueueService.name);
  private readonly connection: Redis;
  private readonly queue: Queue<NotificationsDispatchJob>;

  constructor(@Inject(queueConfig.KEY) private readonly cfg: ConfigType<typeof queueConfig>) {
    this.connection = createRedisConnection(this.cfg.redisUrl);
    this.queue = new Queue<NotificationsDispatchJob>(this.cfg.notificationsQueueName, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 1, // the cron retries; the worker handles per-row retry
        removeOnComplete: { age: 60 * 60, count: 100 },
        removeOnFail: { age: 24 * 60 * 60 },
      },
    });
  }

  /**
   * Cron enqueues one job every 30s. Job id is the minute-bucket so we never
   * enqueue more than one dispatch per 30s window even if multiple instances
   * trigger the cron simultaneously.
   */
  async enqueueDispatch(): Promise<void> {
    const bucket = Math.floor(Date.now() / 30_000);
    await this.queue.add(
      'dispatch',
      { enqueuedAt: Date.now() },
      { jobId: `dispatch-${bucket}` },
    );
    this.logger.debug(`Notifications dispatch enqueued for bucket ${bucket}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
