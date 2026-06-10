import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  OcrDraft as PrismaOcrDraft,
  OcrDraftStatus as PrismaOcrDraftStatus,
  Prisma,
  QuestionType as PrismaQuestionType,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../../shared/database/prisma.service';
import { QuestionType } from '../../questions/models/question-type.enum';
import {
  AssignedTaxonomy,
  DraftOption,
  OcrDraftModel,
  OcrDraftStatus,
  SuggestedAnswer,
} from '../models/ocr-draft.model';
import { Difficulty as PrismaDifficulty } from '@prisma/client';
import {
  CreateDraftInput,
  CreateDraftFigureInput,
  IOcrDraftRepository,
  UpdateDraftInput,
} from './ocr-draft.repository';

@Injectable()
export class PrismaOcrDraftRepository implements IOcrDraftRepository {
  constructor(private readonly prisma: PrismaService) {}

  async bulkCreate(
    input: Array<
      CreateDraftInput & { figures?: Omit<CreateDraftFigureInput, 'draftId' | 'tenantId'>[] }
    >,
  ): Promise<number> {
    if (input.length === 0) return 0;
    const r = await this.prisma.ocrDraft.createMany({
      data: input.map((d) => ({
        tenantId: d.tenantId,
        ocrJobId: d.ocrJobId,
        position: d.position,
        text: d.text,
        detectedType: d.detectedType ? (d.detectedType as PrismaQuestionType) : null,
        options: (d.options as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        confidence:
          d.confidence !== undefined && d.confidence !== null
            ? new Decimal(d.confidence as number)
            : null,
        sourcePageNumber: d.sourcePageNumber ?? null,
        spanPageStart: d.spanPageStart ?? null,
        spanPageEnd: d.spanPageEnd ?? null,
        solutionText: d.solutionText ?? null,
        questionSnapshotKey: d.questionSnapshotKey ?? null,
        optionCount: d.optionCount ?? null,
        questionNumber: d.questionNumber ?? null,
        invalidCrop: d.invalidCrop ?? null,
        sourceCoordinates:
          (d.sourceCoordinates as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      })),
      skipDuplicates: true,
    });

    // Slice 2.3 — insert OcrDraftFigure rows for drafts that carry figures.
    // We need the draft ids that prisma just created; createMany doesn't
    // return them, so we look up the just-inserted rows by (ocrJobId, position).
    const draftsWithFigures = input.filter((d) => d.figures && d.figures.length > 0);
    if (draftsWithFigures.length > 0) {
      const ocrJobId = draftsWithFigures[0].ocrJobId;
      const positions = draftsWithFigures.map((d) => d.position);
      const rows = await this.prisma.ocrDraft.findMany({
        where: { ocrJobId, position: { in: positions } },
        select: { id: true, position: true },
      });
      const idByPosition = new Map(rows.map((row) => [row.position, row.id]));
      const figureData: Prisma.OcrDraftFigureCreateManyInput[] = [];
      for (const d of draftsWithFigures) {
        const draftId = idByPosition.get(d.position);
        if (!draftId) continue;
        for (const f of d.figures!) {
          figureData.push({
            tenantId: d.tenantId,
            draftId,
            figureIndex: f.figureIndex,
            storageKey: f.storageKey,
            boundingBox: f.boundingBox as unknown as Prisma.InputJsonValue,
            kind: f.kind,
            caption: f.caption ?? null,
          });
        }
      }
      if (figureData.length > 0) {
        await this.prisma.ocrDraftFigure.createMany({ data: figureData });
      }
    }
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

  async setSuggestedAnswers(
    tenantId: string,
    items: Array<{ id: string; suggestedAnswer: SuggestedAnswer }>,
  ): Promise<number> {
    if (items.length === 0) return 0;
    // Different value per row → updateMany can't help; run scoped updates in one
    // transaction. Tenant-scoped `where` keeps cross-tenant writes impossible.
    const results = await this.prisma.$transaction(
      items.map((it) =>
        this.prisma.ocrDraft.updateMany({
          where: { id: it.id, tenantId },
          data: {
            suggestedAnswer: it.suggestedAnswer as unknown as Prisma.InputJsonValue,
          },
        }),
      ),
    );
    return results.reduce((n, r) => n + r.count, 0);
  }

  async setTaxonomy(
    tenantId: string,
    ocrJobId: string,
    draftIds: string[] | null,
    taxonomy: AssignedTaxonomy,
  ): Promise<number> {
    // Only write fields explicitly provided (partial merge), so "apply just the
    // Chapter" never clobbers a previously-set Subject.
    const data: Prisma.OcrDraftUpdateManyMutationInput = {};
    if (taxonomy.programId !== undefined) data.assignedProgramId = taxonomy.programId;
    if (taxonomy.subjectId !== undefined) data.assignedSubjectId = taxonomy.subjectId;
    if (taxonomy.topicId !== undefined) data.assignedTopicId = taxonomy.topicId;
    if (taxonomy.chapterId !== undefined) data.assignedChapterId = taxonomy.chapterId;
    if (taxonomy.difficulty !== undefined)
      data.assignedDifficulty = (taxonomy.difficulty as PrismaDifficulty | null) ?? null;
    if (Object.keys(data).length === 0) return 0;

    const r = await this.prisma.ocrDraft.updateMany({
      where: {
        tenantId,
        ocrJobId,
        ...(draftIds ? { id: { in: draftIds } } : {}),
      },
      data,
    });
    return r.count;
  }

  async insertDraftAt(input: {
    tenantId: string;
    ocrJobId: string;
    atNumber: number;
    storageKey: string;
    optionCount?: number;
  }): Promise<OcrDraftModel> {
    return this.prisma.$transaction(async (tx) => {
      // Make room: every question at/after the insert point moves up by one.
      await tx.ocrDraft.updateMany({
        where: {
          tenantId: input.tenantId,
          ocrJobId: input.ocrJobId,
          questionNumber: { gte: input.atNumber },
        },
        data: { questionNumber: { increment: 1 } },
      });
      const created = await tx.ocrDraft.create({
        data: {
          tenantId: input.tenantId,
          ocrJobId: input.ocrJobId,
          position: 0, // recomputed below
          text: '',
          detectedType: 'VISUAL' as PrismaQuestionType,
          options: Prisma.JsonNull,
          confidence: new Decimal(1),
          status: 'PENDING_REVIEW' as PrismaOcrDraftStatus,
          questionSnapshotKey: input.storageKey,
          optionCount: input.optionCount ?? 4,
          questionNumber: input.atNumber,
          invalidCrop: false,
        },
      });
      await this.recomputePositions(tx, input.tenantId, input.ocrJobId);
      const row = await tx.ocrDraft.findUniqueOrThrow({ where: { id: created.id } });
      return this.toModel(row);
    });
  }

  async moveDraftToNumber(
    tenantId: string,
    ocrJobId: string,
    draftId: string,
    targetNumber: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const d = await tx.ocrDraft.findFirst({ where: { id: draftId, tenantId, ocrJobId } });
      if (!d) throw new NotFoundException('OCR draft not found');
      const old = d.questionNumber;
      if (old == null) {
        // Assigning a number to a numberless/invalid crop: only allow a MISSING
        // number, so it fills a gap instead of duplicating an existing question
        // (which would inflate the count). Reorder of a NUMBERED draft (below)
        // shifts the range instead — that path may target a taken number.
        const taken = await tx.ocrDraft.findFirst({
          where: { tenantId, ocrJobId, questionNumber: targetNumber, id: { not: draftId } },
        });
        if (taken) {
          throw new BadRequestException(
            `Question ${targetNumber} already exists — pick a missing number.`,
          );
        }
        await tx.ocrDraft.update({
          where: { id: draftId },
          data: { questionNumber: targetNumber, invalidCrop: false },
        });
      } else if (targetNumber < old) {
        await tx.ocrDraft.updateMany({
          where: { tenantId, ocrJobId, questionNumber: { gte: targetNumber, lt: old } },
          data: { questionNumber: { increment: 1 } },
        });
        await tx.ocrDraft.update({
          where: { id: draftId },
          data: { questionNumber: targetNumber, invalidCrop: false },
        });
      } else if (targetNumber > old) {
        await tx.ocrDraft.updateMany({
          where: { tenantId, ocrJobId, questionNumber: { gt: old, lte: targetNumber } },
          data: { questionNumber: { decrement: 1 } },
        });
        await tx.ocrDraft.update({
          where: { id: draftId },
          data: { questionNumber: targetNumber, invalidCrop: false },
        });
      }
      await this.recomputePositions(tx, tenantId, ocrJobId);
    });
  }

  /** Re-sequence `position` to match question-number order (nulls last) so the
   *  review list and navigator stay consistent after an insert/move. */
  private async recomputePositions(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ocrJobId: string,
  ): Promise<void> {
    const rows = await tx.ocrDraft.findMany({
      where: { tenantId, ocrJobId },
      orderBy: [{ questionNumber: { sort: 'asc', nulls: 'last' } }, { position: 'asc' }],
      select: { id: true },
    });
    for (let i = 0; i < rows.length; i += 1) {
      await tx.ocrDraft.update({ where: { id: rows[i].id }, data: { position: i } });
    }
  }

  private toModel(r: PrismaOcrDraft): OcrDraftModel {
    const model = new OcrDraftModel(
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
    model.questionSnapshotKey = r.questionSnapshotKey ?? null;
    model.optionCount = r.optionCount ?? null;
    model.questionNumber = r.questionNumber ?? null;
    model.invalidCrop = r.invalidCrop ?? null;
    model.sourceCoordinates =
      (r.sourceCoordinates as unknown as Record<string, number> | null) ?? null;
    model.suggestedAnswer = (r.suggestedAnswer as unknown as SuggestedAnswer | null) ?? null;
    model.assignedTaxonomy = {
      programId: r.assignedProgramId,
      subjectId: r.assignedSubjectId,
      topicId: r.assignedTopicId,
      chapterId: r.assignedChapterId,
      difficulty: (r.assignedDifficulty as unknown as AssignedTaxonomy['difficulty']) ?? null,
    };
    return model;
  }
}
