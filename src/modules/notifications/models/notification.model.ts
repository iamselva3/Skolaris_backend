export type NotificationChannel = 'IN_APP' | 'EMAIL';

export class NotificationModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly recipientUserId: string,
    public readonly channel: NotificationChannel,
    public readonly subject: string,
    public readonly body: string,
    public readonly readAt: Date | null,
    public readonly sentAt: Date | null,
    public readonly createdAt: Date,
  ) {}
}
