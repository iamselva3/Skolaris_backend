import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Difficulty as PrismaDifficulty,
  Prisma,
  Question as PrismaQuestion,
  QuestionOption as PrismaQuestionOption,
  QuestionType as PrismaQuestionType,
} from '@prisma/client';
import { PrismaService } from '../../../shared/database/prisma.service';
import { Difficulty, QuestionType } from '../models/question-type.enum';
import { QuestionModel, QuestionOptionModel, QuestionWithOptions } from '../models/question.model';
import {
  CreateQuestionInput,
  IQuestionRepository,
  ListQuestionsFilter,
  UpdateQuestionInput,
} from './question.repository';

@Injectable()
export class PrismaQuestionRepository implements IQuestionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateQuestionInput): Promise<QuestionWithOptions> {
    return this.prisma.$transaction(async (tx) => {
      // Branch scoping: a question belongs to the branch of its creator (same
      // rule as the backfill migration). Tenant-level admins (null branch)
      // create tenant-wide questions.
      const creator = await tx.user.findUnique({
        where: { id: input.createdBy },
        select: { branchId: true },
      });
      const q = await tx.question.create({
        data: {
          tenantId: input.tenantId,
          createdBy: input.createdBy,
          branchId: creator?.branchId ?? null,
          sourceUploadId: input.sourceUploadId ?? null,
          type: input.type as PrismaQuestionType,
          payload: input.payload as Prisma.InputJsonValue,
          programId: input.programId ?? null,
          subjectId: input.subjectId ?? null,
          topicId: input.topicId ?? null,
          chapterId: input.chapterId ?? null,
          subject: input.subject ?? null,
          topic: input.topic ?? null,
          difficulty: (input.difficulty ?? Difficulty.MEDIUM) as PrismaDifficulty,
        },
      });
      let opts: PrismaQuestionOption[] = [];
      if (input.options && input.options.length > 0) {
        await tx.questionOption.createMany({
          data: input.options.map((o) => ({
            tenantId: input.tenantId,
            questionId: q.id,
            label: o.label,
            isCorrect: o.isCorrect,
            position: o.position,
          })),
        });
        opts = await tx.questionOption.findMany({
          where: { questionId: q.id },
          orderBy: { position: 'asc' },
        });
      }
      return { question: this.toQuestion(q), options: opts.map((o) => this.toOption(o)) };
    });
  }

  async findById(tenantId: string, id: string): Promise<QuestionWithOptions | null> {
    const row = await this.prisma.question.findFirst({
      where: { id, tenantId },
      include: { options: { orderBy: { position: 'asc' } } },
    });
    if (!row) return null;
    return {
      question: this.toQuestion(row),
      options: row.options.map((o) => this.toOption(o)),
    };
  }

  async list(filter: ListQuestionsFilter): Promise<{
    data: QuestionWithOptions[];
    total: number;
  }> {
    const where: Prisma.QuestionWhereInput = { tenantId: filter.tenantId };
    if (filter.programId) where.programId = filter.programId;
    if (filter.subjectId) where.subjectId = filter.subjectId;
    if (filter.topicId) where.topicId = filter.topicId;
    if (filter.chapterId) where.chapterId = filter.chapterId;
    if (filter.subject) where.subject = filter.subject;
    if (filter.topic) where.topic = filter.topic;
    if (filter.difficulty) where.difficulty = filter.difficulty as PrismaDifficulty;
    if (filter.type) where.type = filter.type as PrismaQuestionType;
    if (filter.isActive !== undefined) where.isActive = filter.isActive;
    if (filter.q && filter.q.length > 0) {
      where.OR = [
        { subject: { contains: filter.q, mode: 'insensitive' } },
        { topic: { contains: filter.q, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.question.findMany({
        where,
        include: { options: { orderBy: { position: 'asc' } } },
        take: filter.limit,
        skip: filter.offset,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.question.count({ where }),
    ]);
    return {
      data: rows.map((r) => ({
        question: this.toQuestion(r),
        options: r.options.map((o) => this.toOption(o)),
      })),
      total,
    };
  }

  async update(
    tenantId: string,
    id: string,
    input: UpdateQuestionInput,
  ): Promise<QuestionWithOptions> {
    const found = await this.prisma.question.findFirst({ where: { id, tenantId } });
    if (!found) throw new NotFoundException('Question not found');

    return this.prisma.$transaction(async (tx) => {
      await tx.question.update({
        where: { id },
        data: {
          ...(input.payload !== undefined
            ? { payload: input.payload as Prisma.InputJsonValue }
            : {}),
          ...(input.programId !== undefined ? { programId: input.programId } : {}),
          ...(input.subjectId !== undefined ? { subjectId: input.subjectId } : {}),
          ...(input.topicId !== undefined ? { topicId: input.topicId } : {}),
          ...(input.chapterId !== undefined ? { chapterId: input.chapterId } : {}),
          ...(input.subject !== undefined ? { subject: input.subject } : {}),
          ...(input.topic !== undefined ? { topic: input.topic } : {}),
          ...(input.difficulty !== undefined
            ? { difficulty: input.difficulty as PrismaDifficulty }
            : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });
      if (input.options) {
        await tx.questionOption.deleteMany({ where: { questionId: id } });
        if (input.options.length > 0) {
          await tx.questionOption.createMany({
            data: input.options.map((o) => ({
              tenantId,
              questionId: id,
              label: o.label,
              isCorrect: o.isCorrect,
              position: o.position,
            })),
          });
        }
      }
      const refreshed = await tx.question.findUniqueOrThrow({
        where: { id },
        include: { options: { orderBy: { position: 'asc' } } },
      });
      return {
        question: this.toQuestion(refreshed),
        options: refreshed.options.map((o) => this.toOption(o)),
      };
    });
  }

  async softDelete(tenantId: string, id: string): Promise<void> {
    const result = await this.prisma.question.updateMany({
      where: { id, tenantId, isActive: true },
      data: { isActive: false },
    });
    if (result.count === 0) {
      throw new NotFoundException('Question not found');
    }
  }

  async countActive(tenantId: string, createdBy?: string): Promise<number> {
    return this.prisma.question.count({
      where: { tenantId, isActive: true, ...(createdBy ? { createdBy } : {}) },
    });
  }

  private toQuestion(r: PrismaQuestion): QuestionModel {
    return new QuestionModel(
      r.id,
      r.tenantId,
      r.createdBy,
      r.sourceUploadId,
      r.type as QuestionType,
      r.payload as Record<string, unknown>,
      r.programId,
      r.subjectId,
      r.topicId,
      r.chapterId,
      r.subject,
      r.topic,
      r.difficulty as Difficulty,
      r.isActive,
      r.createdAt,
      r.updatedAt,
    );
  }

  private toOption(o: PrismaQuestionOption): QuestionOptionModel {
    return new QuestionOptionModel(
      o.id,
      o.tenantId,
      o.questionId,
      o.label,
      o.isCorrect,
      o.position,
    );
  }
}
