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
import { DispatchPendingNotificationsUseCase } from '../../modules/notifications/use-cases/dispatch-pending-notifications.use-case';
import { NotificationsDispatchJob } from '../queue/notifications-queue.service';
import { createRedisConnection } from '../queue/bullmq.config';

@Injectable()
export class NotificationsProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsProcessor.name);
  private connection!: Redis;
  private worker!: Worker<NotificationsDispatchJob>;

  constructor(
    @Inject(queueConfig.KEY) private readonly cfg: ConfigType<typeof queueConfig>,
    private readonly dispatch: DispatchPendingNotificationsUseCase,
  ) {}

  onModuleInit(): void {
    if (this.cfg.queueDriver === 'inline') {
      this.logger.log(
        'BullMQ notifications worker disabled (QUEUE_DRIVER=inline); dispatch runs in-process — no Redis.',
      );
      return;
    }

    this.connection = createRedisConnection(this.cfg.redisUrl);
    this.worker = new Worker<NotificationsDispatchJob>(
      this.cfg.notificationsQueueName,
      async (job) => {
        const r = await this.dispatch.execute();
        if (r.picked > 0) {
          this.logger.log(
            `Dispatch job ${job.id}: picked=${r.picked} sent=${r.sent} failed=${r.failed}`,
          );
        }
      },
      { connection: this.connection, concurrency: 1 }, // one at a time to avoid double-send
    );
    this.worker.on('failed', (job, err) =>
      this.logger.error(`Notifications job ${job?.id} failed: ${err.message}`),
    );
    this.logger.log(`NotificationsProcessor consuming "${this.cfg.notificationsQueueName}"`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) await this.worker.close();
    if (this.connection) await this.connection.quit();
  }
}
