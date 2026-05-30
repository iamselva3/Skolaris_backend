import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationsQueueService } from '../queue/notifications-queue.service';

@Injectable()
export class NotificationsDispatchCron {
  constructor(private readonly queue: NotificationsQueueService) {}

  // Every 30 seconds. The queue service dedupes by 30s bucket to avoid duplicate jobs.
  @Cron('*/30 * * * * *')
  async run(): Promise<void> {
    await this.queue.enqueueDispatch();
  }
}
