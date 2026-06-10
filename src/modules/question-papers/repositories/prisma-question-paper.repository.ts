import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, QuestionPaper as PrismaPaper, QuestionPaperStatus } from '@prisma/client';
import { PrismaService } from '../../../shared/database/prisma.service';
import {
  CreatePaperInput,
  GenerateRule,
  IQuestionPaperRepository,
  PaperListFilter,
  PaperQuestionInput,
  PaperQuestionRow,
  PaperRow,
  PaperSummary,
  PaperWithQuestions,
  UpdatePaperInput,
} from './question-paper.repository';

@Injectable()
export class PrismaQuestionPaperRepository implements IQuestionPaperRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreatePaperInput): Promise<PaperRow> {
    const row = await this.prisma.questionPaper.create({
      data: {
        tenantId: input.tenantId,
        branchId: input.branchId,
        createdBy: input.createdBy,
        title: input.title,
        description: input.description ?? null,
        programId: input.programId ?? null,
        subjectId: input.subjectId ?? null,
        durationSeconds: input.durationSeconds,
        defaultNegativeMarks: input.defaultNegativeMarks ?? 0,
      },
    });
    return this.toRow(row, 0, []);
  }

  async list(filter: PaperListFilter): Promise<{ data: PaperRow[]; total: number }> {
    const where: Prisma.QuestionPaperWhereInput = { tenantId: filter.tenantId };
    if (filter.createdBy) where.createdBy = filter.createdBy;
    if (filter.status) where.status = filter.status;
    else if (!filter.includeArchived) where.status = { not: 'ARCHIVED' };
    if (filter.programId) where.programId = filter.programId;
    if (filter.subjectId) where.subjectId = filter.subjectId;
    if (filter.q && filter.q.length > 0) {
      where.title = { contains: filter.q, mode: 'insensitive' };
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.questionPaper.findMany({
        where,
        take: filter.limit,
        skip: filter.offset,
        orderBy: { updatedAt: 'desc' },
        include: {
          questions: { select: { question: { select: { subject: true } } } },
        },
      }),
      this.prisma.questionPaper.count({ where }),
    ]);

    const data = rows.map((r) => {
      const subjects = Array.from(
        new Set(r.questions.map((q) => q.question.subject).filter((s): s is string => !!s)),
      );
      return this.toRow(r, r.questions.length, subjects);
    });
    return { data, total };
  }

  async summary(tenantId: string, createdBy?: string): Promise<PaperSummary> {
    const base: Prisma.QuestionPaperWhereInput = { tenantId, ...(createdBy ? { createdBy } : {}) };
    const [total, draft, published, archived] = await this.prisma.$transaction([
      this.prisma.questionPaper.count({ where: { ...base, status: { not: 'ARCHIVED' } } }),
      this.prisma.questionPaper.count({ where: { ...base, status: 'DRAFT' } }),
      this.prisma.questionPaper.count({ where: { ...base, status: 'PUBLISHED' } }),
      this.prisma.questionPaper.count({ where: { ...base, status: 'ARCHIVED' } }),
    ]);
    return { total, draft, published, archived };
  }

  async findById(tenantId: string, id: string): Promise<PaperRow | null> {
    const row = await this.prisma.questionPaper.findFirst({
      where: { id, tenantId },
      include: { questions: { select: { question: { select: { subject: true } } } } },
    });
    if (!row) return null;
    const subjects = Array.from(
      new Set(row.questions.map((q) => q.question.subject).filter((s): s is string => !!s)),
    );
    return this.toRow(row, row.questions.length, subjects);
  }

  async findByIdWithQuestions(tenantId: string, id: string): Promise<PaperWithQuestions | null> {
    const row = await this.prisma.questionPaper.findFirst({
      where: { id, tenantId },
      include: {
        questions: {
          orderBy: { position: 'asc' },
          include: {
            question: { include: { options: { orderBy: { position: 'asc' } } } },
          },
        },
      },
    });
    if (!row) return null;
    const subjects = Array.from(
      new Set(row.questions.map((q) => q.question.subject).filter((s): s is string => !!s)),
    );
    const questions: PaperQuestionRow[] = row.questions.map((pq) => ({
      id: pq.id,
      questionId: pq.questionId,
      position: pq.position,
      marks: Number(pq.marks),
      negativeMarks: Number(pq.negativeMarks),
      type: pq.question.type,
      difficulty: pq.question.difficulty,
      subject: pq.question.subject,
      topic: pq.question.topic,
      payload: pq.question.payload as Record<string, unknown>,
      options: pq.question.options.map((o) => ({
        id: o.id,
        label: o.label,
        isCorrect: o.isCorrect,
        position: o.position,
      })),
    }));
    return { paper: this.toRow(row, questions.length, subjects), questions };
  }

  async update(tenantId: string, id: string, input: UpdatePaperInput): Promise<PaperRow> {
    await this.ensureExists(tenantId, id);
    await this.prisma.questionPaper.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.programId !== undefined ? { programId: input.programId } : {}),
        ...(input.subjectId !== undefined ? { subjectId: input.subjectId } : {}),
        ...(input.durationSeconds !== undefined ? { durationSeconds: input.durationSeconds } : {}),
        ...(input.defaultNegativeMarks !== undefined
          ? { defaultNegativeMarks: input.defaultNegativeMarks }
          : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.archivedAt !== undefined ? { archivedAt: input.archivedAt } : {}),
      },
    });
    return (await this.findById(tenantId, id))!;
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await this.ensureExists(tenantId, id);
    await this.prisma.questionPaper.delete({ where: { id } });
  }

  async clone(
    tenantId: string,
    id: string,
    newCreatedBy: string,
    branchId: string | null,
  ): Promise<PaperRow> {
    const source = await this.prisma.questionPaper.findFirst({
      where: { id, tenantId },
      include: { questions: true },
    });
    if (!source) throw new NotFoundException('Question paper not found');

    const created = await this.prisma.$transaction(async (tx) => {
      const paper = await tx.questionPaper.create({
        data: {
          tenantId,
          branchId,
          createdBy: newCreatedBy,
          title: `Copy of ${source.title}`,
          description: source.description,
          programId: source.programId,
          subjectId: source.subjectId,
          durationSeconds: source.durationSeconds,
          defaultNegativeMarks: source.defaultNegativeMarks,
          totalMarks: source.totalMarks,
          status: 'DRAFT',
        },
      });
      if (source.questions.length > 0) {
        await tx.questionPaperQuestion.createMany({
          data: source.questions.map((q) => ({
            paperId: paper.id,
            questionId: q.questionId,
            position: q.position,
            marks: q.marks,
            negativeMarks: q.negativeMarks,
          })),
        });
      }
      return paper;
    });
    return (await this.findById(tenantId, created.id))!;
  }

  async addQuestions(
    tenantId: string,
    paperId: string,
    items: PaperQuestionInput[],
  ): Promise<PaperRow> {
    await this.ensureExists(tenantId, paperId);
    const existing = await this.prisma.questionPaperQuestion.findMany({
      where: { paperId },
      select: { questionId: true, position: true },
    });
    const present = new Set(existing.map((e) => e.questionId));
    let nextPos = existing.reduce((m, e) => Math.max(m, e.position), -1) + 1;
    const fresh = items.filter((i) => !present.has(i.questionId));
    if (fresh.length > 0) {
      await this.prisma.questionPaperQuestion.createMany({
        data: fresh.map((i) => ({
          paperId,
          questionId: i.questionId,
          position: nextPos++,
          marks: i.marks ?? 1,
          negativeMarks: i.negativeMarks ?? 0,
        })),
        skipDuplicates: true,
      });
    }
    await this.recomputeTotalMarks(paperId);
    return (await this.findById(tenantId, paperId))!;
  }

  async removeQuestion(tenantId: string, paperId: string, questionId: string): Promise<PaperRow> {
    await this.ensureExists(tenantId, paperId);
    await this.prisma.questionPaperQuestion.deleteMany({ where: { paperId, questionId } });
    await this.recomputeTotalMarks(paperId);
    return (await this.findById(tenantId, paperId))!;
  }

  async reorder(
    tenantId: string,
    paperId: string,
    order: Array<{ questionId: string; position: number }>,
  ): Promise<void> {
    await this.ensureExists(tenantId, paperId);
    await this.prisma.$transaction(
      order.map((o) =>
        this.prisma.questionPaperQuestion.updateMany({
          where: { paperId, questionId: o.questionId },
          data: { position: o.position },
        }),
      ),
    );
  }

  async generate(tenantId: string, paperId: string, rules: GenerateRule[]): Promise<number> {
    await this.ensureExists(tenantId, paperId);
    const existing = await this.prisma.questionPaperQuestion.findMany({
      where: { paperId },
      select: { questionId: true, position: true },
    });
    const present = new Set(existing.map((e) => e.questionId));
    let nextPos = existing.reduce((m, e) => Math.max(m, e.position), -1) + 1;
    const toAdd: Array<{ questionId: string }> = [];

    for (const rule of rules) {
      if (!rule.count || rule.count < 1) continue;
      // Random draw via SQL random(); exclude questions already on the paper or
      // already drawn by an earlier rule this run.
      const exclude = [...present, ...toAdd.map((t) => t.questionId)];
      const ids = await this.drawRandomQuestionIds(tenantId, rule, exclude);
      for (const id of ids) {
        toAdd.push({ questionId: id });
        present.add(id);
      }
    }

    if (toAdd.length > 0) {
      await this.prisma.questionPaperQuestion.createMany({
        data: toAdd.map((t) => ({
          paperId,
          questionId: t.questionId,
          position: nextPos++,
          marks: 1,
          negativeMarks: 0,
        })),
        skipDuplicates: true,
      });
      await this.recomputeTotalMarks(paperId);
    }
    return toAdd.length;
  }

  /* ─────────────────────────────────────────── helpers */

  private async drawRandomQuestionIds(
    tenantId: string,
    rule: GenerateRule,
    exclude: string[],
  ): Promise<string[]> {
    const conds: Prisma.Sql[] = [
      Prisma.sql`tenant_id = ${tenantId}::uuid`,
      Prisma.sql`is_active = true`,
    ];
    if (rule.subjectId) conds.push(Prisma.sql`subject_id = ${rule.subjectId}::uuid`);
    if (rule.chapterId) conds.push(Prisma.sql`chapter_id = ${rule.chapterId}::uuid`);
    if (rule.topicId) conds.push(Prisma.sql`topic_id = ${rule.topicId}::uuid`);
    if (rule.difficulty) conds.push(Prisma.sql`difficulty = ${rule.difficulty}::"Difficulty"`);
    if (exclude.length > 0) {
      conds.push(
        Prisma.sql`id NOT IN (${Prisma.join(exclude.map((e) => Prisma.sql`${e}::uuid`))})`,
      );
    }
    const where = Prisma.join(conds, ' AND ');
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM "questions" WHERE ${where} ORDER BY random() LIMIT ${rule.count}`,
    );
    return rows.map((r) => r.id);
  }

  private async recomputeTotalMarks(paperId: string): Promise<void> {
    const agg = await this.prisma.questionPaperQuestion.aggregate({
      where: { paperId },
      _sum: { marks: true },
    });
    await this.prisma.questionPaper.update({
      where: { id: paperId },
      data: { totalMarks: agg._sum.marks ?? 0 },
    });
  }

  private async ensureExists(tenantId: string, id: string): Promise<void> {
    const found = await this.prisma.questionPaper.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Question paper not found');
  }

  private toRow(r: PrismaPaper, questionCount: number, subjects: string[]): PaperRow {
    return {
      id: r.id,
      tenantId: r.tenantId,
      branchId: r.branchId,
      createdBy: r.createdBy,
      title: r.title,
      description: r.description,
      programId: r.programId,
      subjectId: r.subjectId,
      durationSeconds: r.durationSeconds,
      defaultNegativeMarks: Number(r.defaultNegativeMarks),
      totalMarks: Number(r.totalMarks),
      status: r.status as QuestionPaperStatus,
      archivedAt: r.archivedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      questionCount,
      subjects,
    };
  }
}
