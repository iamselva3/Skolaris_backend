import { Injectable, NotFoundException } from '@nestjs/common';
import {
  OcrDraft as PrismaOcrDraft,
  OcrDraftStatus as PrismaOcrDraftStatus,
  Prisma,
  QuestionType as PrismaQuestionType,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../../shared/database/prisma.service';
import { QuestionType } from '../../questions/models/question-type.enum';
import { DraftOption, OcrDraftModel, OcrDraftStatus } from '../models/ocr-draft.model';
import {
  CreateDraftInput,
  IOcrDraftRepository,
  UpdateDraftInput,
} from './ocr-draft.repository';

@Injectable()
export class PrismaOcrDraftRepository implements IOcrDraftRepository {
  constructor(private readonly prisma: PrismaService) {}

  async bulkCreate(input: CreateDraftInput[]): Promise<number> {
    if (input.length === 0) return 0;
    const r = await this.prisma.ocrDraft.createMany({
      data: input.map((d) => ({
        tenantId: d.tenantId,
        ocrJobId: d.ocrJobId,
        position: d.position,
        text: d.text,
        detectedType: d.detectedType ? (d.detectedType as PrismaQuestionType) : null,
        options: (d.options as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        confidence: d.confidence !== undefined && d.confidence !== null
          ? new Decimal(d.confidence as number)
          : null,
      })),
      skipDuplicates: true,
    });
    return r.count;
  }

  async list(
    tenantId: string,
    ocrJobId: string,
    limit: number,
    offset: number,
  ): Promise<{ data: OcrDraftModel[]; total: number }> {
    const where = { tenantId, ocrJobId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.ocrDraft.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { position: 'asc' },
      }),
      this.prisma.ocrDraft.count({ where }),
    ]);
    return { data: rows.map((r) => this.toModel(r)), total };
  }

  async findById(tenantId: string, id: string): Promise<OcrDraftModel | null> {
    const r = await this.prisma.ocrDraft.findFirst({ where: { id, tenantId } });
    return r ? this.toModel(r) : null;
  }

  async update(tenantId: string, id: string, input: UpdateDraftInput): Promise<OcrDraftModel> {
    const found = await this.prisma.ocrDraft.findFirst({ where: { id, tenantId } });
    if (!found) throw new NotFoundException('OCR draft not found');
    const updated = await this.prisma.ocrDraft.update({
      where: { id },
      data: {
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.detectedType !== undefined
          ? { detectedType: input.detectedType ? (input.detectedType as PrismaQuestionType) : null }
          : {}),
        ...(input.options !== undefined
          ? { options: (input.options as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull }
          : {}),
        ...(input.status !== undefined ? { status: input.status as PrismaOcrDraftStatus } : {}),
        ...(input.approvedQuestionId !== undefined
          ? { approvedQuestionId: input.approvedQuestionId }
          : {}),
      },
    });
    return this.toModel(updated);
  }

  async countByJob(tenantId: string, ocrJobId: string): Promise<number> {
    return this.prisma.ocrDraft.count({ where: { tenantId, ocrJobId } });
  }

  private toModel(r: PrismaOcrDraft): OcrDraftModel {
    return new OcrDraftModel(
      r.id,
      r.tenantId,
      r.ocrJobId,
      r.position,
      r.text,
      r.detectedType ? (r.detectedType as QuestionType) : null,
      (r.options as unknown as DraftOption[] | null) ?? null,
      r.confidence,
      r.status as OcrDraftStatus,
      r.approvedQuestionId,
      r.createdAt,
      r.updatedAt,
    );
  }
}
