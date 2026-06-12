import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Upload as PrismaUpload, UploadStatus as PrismaUploadStatus } from '@prisma/client';
import { PrismaService } from '../../../shared/database/prisma.service';
import { UploadModel, UploadStatus } from '../models/upload.model';
import { CreateUploadInput, IUploadRepository } from './upload.repository';

@Injectable()
export class PrismaUploadRepository implements IUploadRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateUploadInput): Promise<UploadModel> {
    // Branch scoping: an upload belongs to the branch of its uploader (same
    // rule as the backfill migration). Tenant-level admins (null branch)
    // create tenant-wide uploads.
    const uploader = await this.prisma.user.findUnique({
      where: { id: input.uploadedBy },
      select: { branchId: true },
    });
    const row = await this.prisma.upload.create({
      data: {
        tenantId: input.tenantId,
        uploadedBy: input.uploadedBy,
        branchId: uploader?.branchId ?? null,
        originalName: input.originalName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes !== null ? BigInt(input.sizeBytes) : null,
        storageKey: input.storageKey,
        programId: input.programId ?? null,
        subjectId: input.subjectId ?? null,
      },
    });
    return this.toModel(row);
  }

  async failStuckProcessing(cutoff: Date, errorMessage: string): Promise<number> {
    const result = await this.prisma.upload.updateMany({
      where: { status: 'PROCESSING', updatedAt: { lt: cutoff } },
      data: { status: 'FAILED', errorMessage },
    });
    return result.count;
  }

  async findById(tenantId: string, id: string): Promise<UploadModel | null> {
    const row = await this.prisma.upload.findFirst({
      where: { id, tenantId },
      include: { ocrJob: { select: { _count: { select: { drafts: true } } } } },
    });
    return row ? this.toModel(row, row.ocrJob?._count.drafts ?? null) : null;
  }

  async list(
    tenantId: string,
    filters: { status?: UploadStatus; uploadedBy?: string; limit: number; offset: number },
  ): Promise<{ data: UploadModel[]; total: number }> {
    // Batch members are represented in the queue by a single collapsed batch row
    // (GET /ocr/batches), so exclude them here — the queue lists standalone
    // (non-batch) uploads only. Also exclude inline question images and answer keys.
    const where: Prisma.UploadWhereInput = {
      tenantId,
      batchId: null,
      NOT: {
        OR: [
          { storageKey: { contains: '/question-images/' } },
          { storageKey: { contains: '/answer-keys/' } },
          { originalName: { contains: 'answer key', mode: 'insensitive' } },
          { originalName: { contains: 'answer_key', mode: 'insensitive' } },
        ],
      },
    };
    if (filters.status) where.status = filters.status as PrismaUploadStatus;
    if (filters.uploadedBy) where.uploadedBy = filters.uploadedBy;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.upload.findMany({
        where,
        take: filters.limit,
        skip: filters.offset,
        orderBy: { createdAt: 'desc' },
        // _count of drafts powers the UploadsListPage's "Drafts" column.
        include: { ocrJob: { select: { _count: { select: { drafts: true } } } } },
      }),
      this.prisma.upload.count({ where }),
    ]);
    return {
      data: rows.map((r) => this.toModel(r, r.ocrJob?._count.drafts ?? null)),
      total,
    };
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: UploadStatus,
    errorMessage?: string | null,
  ): Promise<UploadModel> {
    const found = await this.prisma.upload.findFirst({ where: { id, tenantId } });
    if (!found) throw new NotFoundException('Upload not found');
    const updated = await this.prisma.upload.update({
      where: { id },
      data: {
        status: status as PrismaUploadStatus,
        ...(errorMessage !== undefined ? { errorMessage } : {}),
      },
    });
    return this.toModel(updated);
  }

  async remove(tenantId: string, id: string): Promise<UploadModel> {
    const found = await this.prisma.upload.findFirst({ where: { id, tenantId } });
    if (!found) throw new NotFoundException('Upload not found');
    const deleted = await this.prisma.upload.delete({ where: { id } });
    return this.toModel(deleted);
  }

  async assignBatch(
    tenantId: string,
    uploadId: string,
    batchId: string,
    batchOrder: number,
  ): Promise<void> {
    // Tenant-scoped guard via updateMany so a wrong tenant simply updates nothing.
    await this.prisma.upload.updateMany({
      where: { id: uploadId, tenantId },
      data: { batchId, batchOrder },
    });
  }

  async listByBatch(tenantId: string, batchId: string): Promise<UploadModel[]> {
    const rows = await this.prisma.upload.findMany({
      where: { tenantId, batchId },
      orderBy: { batchOrder: 'asc' },
      include: { ocrJob: { select: { _count: { select: { drafts: true } } } } },
    });
    return rows.map((r) => this.toModel(r, r.ocrJob?._count.drafts ?? null));
  }

  private toModel(r: PrismaUpload, draftCount: number | null = null): UploadModel {
    return new UploadModel(
      r.id,
      r.tenantId,
      r.uploadedBy,
      r.originalName,
      r.mimeType,
      r.sizeBytes,
      r.storageKey,
      r.status as UploadStatus,
      r.errorMessage,
      r.programId,
      r.subjectId,
      r.createdAt,
      r.updatedAt,
      draftCount,
      r.batchId,
      r.batchOrder,
    );
  }
}
