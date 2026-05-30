import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  NOTIFICATIONS_DISPATCHER,
  INotificationsDispatcher,
} from '../queue/notifications-dispatcher';

@Injectable()
export class NotificationsDispatchCron {
  constructor(
    @Inject(NOTIFICATIONS_DISPATCHER) private readonly queue: INotificationsDispatcher,
  ) {}

  // Every 30 seconds. The queue service dedupes by 30s bucket to avoid duplicate jobs.
  @Cron('*/30 * * * * *')
  async run(): Promise<void> {
    await this.queue.enqueueDispatch();
  }
}
