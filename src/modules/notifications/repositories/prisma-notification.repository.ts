import { Injectable } from '@nestjs/common';
import {
  Notification as PrismaNotification,
  NotificationChannel as PrismaChannel,
} from '@prisma/client';
import { PrismaService } from '../../../shared/database/prisma.service';
import { NotificationChannel, NotificationModel } from '../models/notification.model';
import {
  CreateNotificationInput,
  INotificationRepository,
} from './notification.repository';

@Injectable()
export class PrismaNotificationRepository implements INotificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateNotificationInput): Promise<NotificationModel> {
    const row = await this.prisma.notification.create({
      data: {
        tenantId: input.tenantId,
        recipientUserId: input.recipientUserId,
        channel: input.channel as PrismaChannel,
        subject: input.subject,
        body: input.body,
        sentAt: input.channel === 'IN_APP' ? new Date() : null,
      },
    });
    return this.toModel(row);
  }

  async listForUser(
    tenantId: string,
    userId: string,
    limit: number,
    offset: number,
  ): Promise<{ data: NotificationModel[]; total: number; unread: number }> {
    const where = { tenantId, recipientUserId: userId };
    const [rows, total, unread] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { ...where, readAt: null } }),
    ]);
    return { data: rows.map((r) => this.toModel(r)), total, unread };
  }

  async markRead(
    tenantId: string,
    userId: string,
    id: string,
  ): Promise<NotificationModel | null> {
    const found = await this.prisma.notification.findFirst({
      where: { id, tenantId, recipientUserId: userId },
    });
    if (!found) return null;
    const updated = await this.prisma.notification.update({
      where: { id },
      data: { readAt: found.readAt ?? new Date() },
    });
    return this.toModel(updated);
  }

  async delete(tenantId: string, userId: string, id: string): Promise<boolean> {
    const res = await this.prisma.notification.deleteMany({
      where: { id, tenantId, recipientUserId: userId },
    });
    return res.count > 0;
  }

  async deleteAll(tenantId: string, userId: string): Promise<number> {
    const res = await this.prisma.notification.deleteMany({
      where: { tenantId, recipientUserId: userId },
    });
    return res.count;
  }

  private toModel(r: PrismaNotification): NotificationModel {
    return new NotificationModel(
      r.id,
      r.tenantId,
      r.recipientUserId,
      r.channel as NotificationChannel,
      r.subject,
      r.body,
      r.readAt,
      r.sentAt,
      r.createdAt,
    );
  }
}
