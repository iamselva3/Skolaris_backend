import { Inject, Injectable } from '@nestjs/common';
import { NotificationModel } from '../models/notification.model';
import {
  INotificationRepository,
  NOTIFICATION_REPOSITORY,
} from '../repositories/notification.repository';

export interface ListNotificationsResult {
  data: NotificationModel[];
  meta: { total: number; unread: number; limit: number; offset: number };
}

@Injectable()
export class ListNotificationsForUserUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly repo: INotificationRepository,
  ) {}

  async execute(input: {
    tenantId: string;
    userId: string;
    limit: number;
    offset: number;
  }): Promise<ListNotificationsResult> {
    const { data, total, unread } = await this.repo.listForUser(
      input.tenantId,
      input.userId,
      input.limit,
      input.offset,
    );
    return { data, meta: { total, unread, limit: input.limit, offset: input.offset } };
  }
}
