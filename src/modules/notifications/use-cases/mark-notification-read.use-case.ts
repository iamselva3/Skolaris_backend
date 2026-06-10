import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { NotificationModel } from '../models/notification.model';
import {
  INotificationRepository,
  NOTIFICATION_REPOSITORY,
} from '../repositories/notification.repository';

@Injectable()
export class MarkNotificationReadUseCase {
  constructor(@Inject(NOTIFICATION_REPOSITORY) private readonly repo: INotificationRepository) {}

  async execute(input: {
    tenantId: string;
    userId: string;
    id: string;
  }): Promise<NotificationModel> {
    const r = await this.repo.markRead(input.tenantId, input.userId, input.id);
    if (!r) throw new NotFoundException('Notification not found');
    return r;
  }
}
