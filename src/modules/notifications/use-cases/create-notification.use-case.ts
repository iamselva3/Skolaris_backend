import { Inject, Injectable } from '@nestjs/common';
import { NotificationChannel, NotificationModel } from '../models/notification.model';
import {
  CreateNotificationInput,
  INotificationRepository,
  NOTIFICATION_REPOSITORY,
} from '../repositories/notification.repository';

@Injectable()
export class CreateNotificationUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly repo: INotificationRepository,
  ) {}

  execute(input: {
    tenantId: string;
    recipientUserId: string;
    channel?: NotificationChannel;
    subject: string;
    body: string;
  }): Promise<NotificationModel> {
    const payload: CreateNotificationInput = {
      tenantId: input.tenantId,
      recipientUserId: input.recipientUserId,
      channel: input.channel ?? 'IN_APP',
      subject: input.subject,
      body: input.body,
    };
    return this.repo.create(payload);
  }
}
