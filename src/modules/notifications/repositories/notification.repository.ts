import { NotificationChannel, NotificationModel } from '../models/notification.model';

export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');

export interface CreateNotificationInput {
  tenantId: string;
  recipientUserId: string;
  channel: NotificationChannel;
  subject: string;
  body: string;
}

export interface INotificationRepository {
  create(input: CreateNotificationInput): Promise<NotificationModel>;
  listForUser(
    tenantId: string,
    userId: string,
    limit: number,
    offset: number,
  ): Promise<{ data: NotificationModel[]; total: number; unread: number }>;
  markRead(tenantId: string, userId: string, id: string): Promise<NotificationModel | null>;
  delete(tenantId: string, userId: string, id: string): Promise<boolean>;
  deleteAll(tenantId: string, userId: string): Promise<number>;
}
