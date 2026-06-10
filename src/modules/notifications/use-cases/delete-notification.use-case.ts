import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  INotificationRepository,
  NOTIFICATION_REPOSITORY,
} from '../repositories/notification.repository';

@Injectable()
export class DeleteNotificationUseCase {
  constructor(@Inject(NOTIFICATION_REPOSITORY) private readonly repo: INotificationRepository) {}

  async execute(input: { tenantId: string; userId: string; id: string }): Promise<void> {
    const deleted = await this.repo.delete(input.tenantId, input.userId, input.id);
    if (!deleted) {
      throw new NotFoundException('Notification not found');
    }
  }

  async executeBulk(input: { tenantId: string; userId: string }): Promise<void> {
    await this.repo.deleteAll(input.tenantId, input.userId);
  }
}
