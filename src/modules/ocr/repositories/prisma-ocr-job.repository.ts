import { Injectable } from '@nestjs/common';
import { OcrJob as PrismaOcrJob, Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type { CachedPageOcr } from '../../../shared/ocr-engine/ocr-engine';
import type { OcrCallbackDto } from '../dtos/ocr-callback.dto';
import { PrismaService } from '../../../shared/database/prisma.service';
import { OcrJobModel } from '../models/ocr-job.model';
import { CreateOcrJobInput, IOcrJobRepository, ResumableOcrJob } from './ocr-job.repository';

/** Non-terminal OCR statuses eligible for auto-resume. */
const RESUMABLE_STATUSES = ['QUEUED', 'PROCESSING', 'RESUMING', 'PAUSED'];

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
    progress: { stage?: string; processed?: number; total?: number; currentPage?: number; queuePosition?: number },
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

  // ─── Resumable OCR (P0) ─────────────────────────────────────────────────────

  async markRunning(id: string): Promise<{ attemptCount: number }> {
    // COALESCE keeps the first startedAt across resumes; GREATEST is unnecessary here.
    const rows = await this.prisma.$queryRaw<Array<{ attempt_count: number }>>`
      UPDATE ocr_jobs
         SET status = 'PROCESSING',
             attempt_count = attempt_count + 1,
             error_message = NULL,
             started_at = COALESCE(started_at, now()),
             updated_at = now()
       WHERE id = ${id}::uuid
       RETURNING attempt_count`;
    return { attemptCount: Number(rows[0]?.attempt_count ?? 0) };
  }

  async markPaused(id: string, reason: string): Promise<void> {
    // No finishedAt — the job stays non-terminal so recovery resumes it.
    await this.prisma.ocrJob.update({
      where: { id },
      data: { status: 'PAUSED', errorMessage: reason.slice(0, 500) },
    });
  }

  async markResuming(id: string): Promise<void> {
    // Touch Upload.updatedAt too so the periodic staleness sweep won't re-pick this
    // job before its resumed run() has had a chance to start emitting progress.
    await this.prisma.$transaction([
      this.prisma.ocrJob.update({ where: { id }, data: { status: 'RESUMING' } }),
      this.prisma.$executeRaw`
        UPDATE uploads SET updated_at = now()
         WHERE id = (SELECT upload_id FROM ocr_jobs WHERE id = ${id}::uuid)`,
    ]);
  }

  async markCompletedStatus(id: string): Promise<void> {
    // finishedAt is set by markFinished (handleCallback). Here we only flip the
    // lifecycle flag and reclaim the per-page checkpoints — the drafts are durable now.
    await this.prisma.$transaction([
      this.prisma.ocrJob.update({ where: { id }, data: { status: 'COMPLETED' } }),
      this.prisma.ocrPageCheckpoint.deleteMany({ where: { ocrJobId: id } }),
    ]);
  }

  async savePageCheckpoint(
    id: string,
    pageNumber: number,
    totalPages: number,
    artifact: CachedPageOcr,
  ): Promise<void> {
    // Upsert the page artifact, bump lastCompletedPage (GREATEST so the pooled
    // out-of-order path is safe), record totalPages, and touch Upload.updatedAt so
    // the StuckUploadsCron / staleness gate sees the worker is alive.
    await this.prisma.$transaction([
      this.prisma.ocrPageCheckpoint.upsert({
        where: { ocrJobId_pageNumber: { ocrJobId: id, pageNumber } },
        create: {
          ocrJobId: id,
          pageNumber,
          artifact: artifact as unknown as Prisma.InputJsonValue,
        },
        update: { artifact: artifact as unknown as Prisma.InputJsonValue },
      }),
      this.prisma.$executeRaw`
        UPDATE ocr_jobs
           SET last_completed_page = GREATEST(last_completed_page, ${pageNumber}),
               total_pages = ${totalPages},
               updated_at = now()
         WHERE id = ${id}::uuid`,
      this.prisma.$executeRaw`
        UPDATE uploads SET updated_at = now()
         WHERE id = (SELECT upload_id FROM ocr_jobs WHERE id = ${id}::uuid)`,
    ]);
  }

  async loadPageCheckpoint(id: string, pageNumber: number): Promise<CachedPageOcr | null> {
    const row = await this.prisma.ocrPageCheckpoint.findUnique({
      where: { ocrJobId_pageNumber: { ocrJobId: id, pageNumber } },
      select: { artifact: true },
    });
    return row ? (row.artifact as unknown as CachedPageOcr) : null;
  }

  /** Sentinel pageNumber for the result-level checkpoint. Real OCR pages are
   *  1-based, so 0 never collides and is cleared by markCompletedStatus's
   *  deleteMany. Does NOT touch last_completed_page / total_pages. */
  private static readonly RESULT_PAGE = 0;

  async saveResultCheckpoint(id: string, result: OcrCallbackDto): Promise<void> {
    const pageNumber = PrismaOcrJobRepository.RESULT_PAGE;
    await this.prisma.ocrPageCheckpoint.upsert({
      where: { ocrJobId_pageNumber: { ocrJobId: id, pageNumber } },
      create: { ocrJobId: id, pageNumber, artifact: result as unknown as Prisma.InputJsonValue },
      update: { artifact: result as unknown as Prisma.InputJsonValue },
    });
  }

  async loadResultCheckpoint(id: string): Promise<OcrCallbackDto | null> {
    const row = await this.prisma.ocrPageCheckpoint.findUnique({
      where: {
        ocrJobId_pageNumber: { ocrJobId: id, pageNumber: PrismaOcrJobRepository.RESULT_PAGE },
      },
      select: { artifact: true },
    });
    return row ? (row.artifact as unknown as OcrCallbackDto) : null;
  }

  async findResumable(opts: {
    maxAttempts: number;
    staleBefore: Date;
    includeFresh: boolean;
  }): Promise<ResumableOcrJob[]> {
    const where: Prisma.OcrJobWhereInput = {
      finishedAt: null,
      status: { in: RESUMABLE_STATUSES },
      attemptCount: { lt: opts.maxAttempts },
      upload: { is: { status: 'PROCESSING' } },
    };
    if (!opts.includeFresh) {
      // Periodic sweep: resume PAUSED immediately, or PROCESSING/RESUMING/QUEUED
      // jobs that have gone silent (Upload.updatedAt older than the cutoff).
      where.OR = [
        { status: 'PAUSED' },
        { upload: { is: { updatedAt: { lt: opts.staleBefore } } } },
      ];
    }
    const rows = await this.prisma.ocrJob.findMany({
      where,
      select: {
        id: true,
        tenantId: true,
        uploadId: true,
        status: true,
        attemptCount: true,
        lastCompletedPage: true,
        upload: { select: { storageKey: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenantId,
      uploadId: r.uploadId,
      storageKey: r.upload.storageKey,
      status: r.status,
      attemptCount: r.attemptCount,
      lastCompletedPage: r.lastCompletedPage,
    }));
  }

  async failExhausted(maxAttempts: number, reason: string): Promise<number> {
    const stuck = await this.prisma.ocrJob.findMany({
      where: {
        finishedAt: null,
        status: { in: RESUMABLE_STATUSES },
        attemptCount: { gte: maxAttempts },
        upload: { is: { status: 'PROCESSING' } },
      },
      select: { id: true, uploadId: true },
    });
    if (stuck.length === 0) return 0;
    const ids = stuck.map((s) => s.id);
    const uploadIds = stuck.map((s) => s.uploadId);
    await this.prisma.$transaction([
      this.prisma.ocrJob.updateMany({
        where: { id: { in: ids } },
        data: { status: 'FAILED', finishedAt: new Date(), errorMessage: reason.slice(0, 500) },
      }),
      this.prisma.upload.updateMany({
        where: { id: { in: uploadIds } },
        data: { status: 'FAILED', errorMessage: reason.slice(0, 500) },
      }),
    ]);
    return stuck.length;
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
      r.status ?? null,
      r.totalPages ?? null,
      r.lastCompletedPage ?? 0,
      r.attemptCount ?? 0,
    );
  }
}
