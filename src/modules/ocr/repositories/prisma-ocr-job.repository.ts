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
    pageMetadata?: unknown | null;
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
        ...(input.pageMetadata !== undefined
          ? {
              pageMetadata:
                input.pageMetadata === null
                  ? Prisma.JsonNull
                  : (input.pageMetadata as Prisma.InputJsonValue),
            }
          : {}),
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

  async updateProgress(
    id: string,
    progress: { stage?: string; processed?: number; total?: number; currentPage?: number },
  ): Promise<void> {
    // Read-modify-write merge — Prisma 5 can't deep-merge JSON columns natively.
    // The rate of updates is bounded by page count (25-50 for typical NEET PDFs)
    // so two queries per page is acceptable. If this becomes a hotspot, switch
    // to a single $executeRawUnsafe with jsonb_set.
    //
    // ALSO touches Upload.updatedAt — that column is the StuckUploadsCron's
    // liveness signal. Without this touch, long Paddle/Tesseract runs (>5 min)
    // get falsely flipped to FAILED by the watchdog while the worker is still
    // processing. A per-page tick keeps the upload row fresh for the watchdog
    // and is byte-identical for every other consumer (status unchanged).
    const row = await this.prisma.ocrJob.findUnique({
      where: { id },
      select: { progress: true, uploadId: true },
    });
    if (!row) return;
    const current = (row.progress as Record<string, unknown> | null) ?? {};
    const merged: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(progress)) {
      if (v !== undefined) merged[k] = v;
    }
    await this.prisma.$transaction([
      this.prisma.ocrJob.update({
        where: { id },
        data: { progress: merged as unknown as Prisma.InputJsonValue },
      }),
      this.prisma.upload.update({
        where: { id: row.uploadId },
        data: { updatedAt: new Date() },
      }),
    ]);
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
      r.progress ?? null,
    );
  }
}
