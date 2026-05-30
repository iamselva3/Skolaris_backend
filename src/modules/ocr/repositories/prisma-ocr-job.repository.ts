import { Injectable } from '@nestjs/common';
import { OcrJob as PrismaOcrJob, Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../../shared/database/prisma.service';
import { OcrJobModel } from '../models/ocr-job.model';
import { CreateOcrJobInput, IOcrJobRepository } from './ocr-job.repository';

@Injectable()
export class PrismaOcrJobRepository implements IOcrJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateOcrJobInput): Promise<OcrJobModel> {
    const row = await this.prisma.ocrJob.create({
      data: { tenantId: input.tenantId, uploadId: input.uploadId },
    });
    return this.toModel(row);
  }

  async findById(tenantId: string, id: string): Promise<OcrJobModel | null> {
    const row = await this.prisma.ocrJob.findFirst({ where: { id, tenantId } });
    return row ? this.toModel(row) : null;
  }

  async findByIdAnyTenant(id: string): Promise<OcrJobModel | null> {
    const row = await this.prisma.ocrJob.findUnique({ where: { id } });
    return row ? this.toModel(row) : null;
  }

  async findByUploadId(tenantId: string, uploadId: string): Promise<OcrJobModel | null> {
    const row = await this.prisma.ocrJob.findFirst({ where: { uploadId, tenantId } });
    return row ? this.toModel(row) : null;
  }

  async countDraftsByStatus(tenantId: string, ocrJobId: string): Promise<Record<string, number>> {
    const grouped = await this.prisma.ocrDraft.groupBy({
      by: ['status'],
      where: { tenantId, ocrJobId },
      _count: { _all: true },
    });
    const out: Record<string, number> = {
      PENDING_REVIEW: 0,
      EDITED: 0,
      APPROVED: 0,
      DISCARDED: 0,
    };
    for (const g of grouped) {
      out[g.status] = g._count._all;
    }
    return out;
  }

  async markFinished(input: {
    id: string;
    overallConfidence: Decimal | null;
    rawOutput: unknown;
    providerUsed: string | null;
  }): Promise<OcrJobModel> {
    const row = await this.prisma.ocrJob.update({
      where: { id: input.id },
      data: {
        finishedAt: new Date(),
        startedAt: { set: new Date() },
        overallConfidence: input.overallConfidence,
        rawOutput:
          input.rawOutput === null || input.rawOutput === undefined
            ? Prisma.JsonNull
            : (input.rawOutput as Prisma.InputJsonValue),
        providerUsed: input.providerUsed,
      },
    });
    return this.toModel(row);
  }

  async markFailed(input: { id: string; errorMessage: string }): Promise<OcrJobModel> {
    const row = await this.prisma.ocrJob.update({
      where: { id: input.id },
      data: { finishedAt: new Date(), errorMessage: input.errorMessage },
    });
    return this.toModel(row);
  }

  private toModel(r: PrismaOcrJob): OcrJobModel {
    return new OcrJobModel(
      r.id,
      r.tenantId,
      r.uploadId,
      r.queuedAt,
      r.startedAt,
      r.finishedAt,
      r.overallConfidence,
      r.errorMessage,
      r.rawOutput,
      r.providerUsed,
      r.createdAt,
      r.updatedAt,
    );
  }
}
