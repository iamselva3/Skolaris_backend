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
import { INotificationsDispatcher } from './notifications-dispatcher';

export interface NotificationsDispatchJob {
  // No payload — the worker queries the DB for unsent rows.
  enqueuedAt: number;
}

/**
 * BullMQ producer for notification dispatch — the 'redis' NotificationsDispatcher.
 * LAZY: connection + Queue are created on first enqueueDispatch(), so under
 * QUEUE_DRIVER=inline this service opens NO Redis connection (the inline
 * dispatcher runs the pass directly). Mirrors OcrQueueService.
 */
@Injectable()
export class NotificationsQueueService implements OnModuleDestroy, INotificationsDispatcher {
  private readonly logger = new Logger(NotificationsQueueService.name);
  private connection: Redis | null = null;
  private queue: Queue<NotificationsDispatchJob> | null = null;

  constructor(@Inject(queueConfig.KEY) private readonly cfg: ConfigType<typeof queueConfig>) {}

  private ensureQueue(): Queue<NotificationsDispatchJob> {
    if (!this.queue) {
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
    return this.queue;
  }

  /**
   * Cron enqueues one job every 30s. Job id is the minute-bucket so we never
   * enqueue more than one dispatch per 30s window even if multiple instances
   * trigger the cron simultaneously.
   */
  async enqueueDispatch(): Promise<void> {
    const bucket = Math.floor(Date.now() / 30_000);
    await this.ensureQueue().add(
      'dispatch',
      { enqueuedAt: Date.now() },
      { jobId: `dispatch-${bucket}` },
    );
    this.logger.debug(`Notifications dispatch enqueued for bucket ${bucket}`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.queue) await this.queue.close();
    if (this.connection) await this.connection.quit();
  }
}
