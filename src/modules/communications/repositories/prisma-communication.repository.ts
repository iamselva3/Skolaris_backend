import { Injectable } from '@nestjs/common';
import { Communication as PrismaCommunication, Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/database/prisma.service';
import {
  CommunicationModel,
  CommunicationStatus,
  CommunicationType,
  DeliveryChannel,
} from '../models/communication.model';
import { ICommunicationRepository, ListCommunicationsFilter } from './communication.repository';

@Injectable()
export class PrismaCommunicationRepository implements ICommunicationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    filter: ListCommunicationsFilter,
  ): Promise<{ data: CommunicationModel[]; total: number }> {
    const where: Prisma.CommunicationWhereInput = { tenantId: filter.tenantId };

    if (filter.type) where.type = filter.type;
    if (filter.channel) where.channel = filter.channel;
    if (filter.status) where.status = filter.status;

    if (filter.dateFrom || filter.dateTo) {
      where.sentAt = {
        ...(filter.dateFrom ? { gte: filter.dateFrom } : {}),
        ...(filter.dateTo ? { lte: filter.dateTo } : {}),
      };
    }

    if (filter.q) {
      const term = filter.q.trim();
      where.OR = [
        { title: { contains: term, mode: 'insensitive' } },
        { body: { contains: term, mode: 'insensitive' } },
        { audience: { contains: term, mode: 'insensitive' } },
        { sentByName: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.communication.findMany({
        where,
        take: filter.limit,
        skip: filter.offset,
        // Newest first; scheduled (not-yet-sent) rows have null sentAt and sort to
        // the bottom of a desc order, so fall back to createdAt to keep them visible.
        orderBy: [{ sentAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      }),
      this.prisma.communication.count({ where }),
    ]);

    return { data: rows.map((r) => this.toModel(r)), total };
  }

  async getById(tenantId: string, id: string): Promise<CommunicationModel | null> {
    const row = await this.prisma.communication.findFirst({ where: { id, tenantId } });
    return row ? this.toModel(row) : null;
  }

  private toModel(r: PrismaCommunication): CommunicationModel {
    return {
      id: r.id,
      tenantId: r.tenantId,
      title: r.title,
      body: r.body,
      type: r.type as CommunicationType,
      channel: r.channel as DeliveryChannel,
      status: r.status as CommunicationStatus,
      audience: r.audience,
      recipientCount: r.recipientCount,
      deliveredCount: r.deliveredCount,
      failedCount: r.failedCount,
      sentById: r.sentById,
      sentByName: r.sentByName,
      scheduledAt: r.scheduledAt,
      sentAt: r.sentAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}
