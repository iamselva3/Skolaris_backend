import { Injectable } from '@nestjs/common';
import { OcrBatch as PrismaOcrBatch } from '@prisma/client';
import { PrismaService } from '../../../shared/database/prisma.service';
import { OcrBatchModel } from '../models/ocr-batch.model';
import {
  CreateOcrBatchInput,
  IOcrBatchRepository,
  OcrBatchListItem,
} from './ocr-batch.repository';

const TERMINAL_DONE = new Set(['READY_FOR_REVIEW', 'APPROVED']);

@Injectable()
export class PrismaOcrBatchRepository implements IOcrBatchRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateOcrBatchInput): Promise<OcrBatchModel> {
    const row = await this.prisma.ocrBatch.create({
      data: {
        tenantId: input.tenantId,
        createdBy: input.createdBy,
        totalFiles: input.totalFiles,
      },
    });
    return this.toModel(row);
  }

  async findById(tenantId: string, id: string): Promise<OcrBatchModel | null> {
    const row = await this.prisma.ocrBatch.findFirst({ where: { id, tenantId } });
    return row ? this.toModel(row) : null;
  }

  async listByTenant(
    tenantId: string,
    limit: number,
    offset: number,
  ): Promise<{ data: OcrBatchListItem[]; total: number }> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.ocrBatch.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          uploads: {
            orderBy: { batchOrder: 'asc' },
            select: {
              id: true,
              status: true,
              ocrJob: { select: { _count: { select: { drafts: true } } } },
            },
          },
        },
      }),
      this.prisma.ocrBatch.count({ where: { tenantId } }),
    ]);

    const data: OcrBatchListItem[] = rows.map((b) => {
      const ups = b.uploads;
      return {
        batchId: b.id,
        totalFiles: b.totalFiles,
        fileCount: ups.length,
        questionCount: ups.reduce((s, u) => s + (u.ocrJob?._count.drafts ?? 0), 0),
        completed: ups.filter((u) => TERMINAL_DONE.has(u.status)).length,
        failed: ups.filter((u) => u.status === 'FAILED').length,
        processing: ups.some((u) => !TERMINAL_DONE.has(u.status) && u.status !== 'FAILED'),
        firstUploadId: ups[0]?.id ?? null,
        createdAt: b.createdAt,
      };
    });
    return { data, total };
  }

  private toModel(r: PrismaOcrBatch): OcrBatchModel {
    return new OcrBatchModel(r.id, r.tenantId, r.createdBy, r.totalFiles, r.createdAt, r.updatedAt);
  }
}
