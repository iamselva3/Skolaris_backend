import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AttemptAnswer as PrismaAttemptAnswer,
  AttemptStatus as PrismaAttemptStatus,
  ExamAttempt as PrismaExamAttempt,
  Prisma,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../../shared/database/prisma.service';
import { AttemptAnswerModel } from '../models/attempt-answer.model';
import { AttemptStatus, ExamAttemptModel } from '../models/exam-attempt.model';
import {
  BulkCreateAttemptInput,
  IExamAttemptRepository,
  ListAttemptsFilter,
  UpsertAnswerInput,
} from './exam-attempt.repository';

const randomSeed = (): bigint => {
  // 8 random bytes → unsigned 64-bit; clamp to Postgres BIGINT signed range.
  const buf = randomBytes(8);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return view.getBigInt64(0);
};

@Injectable()
export class PrismaExamAttemptRepository implements IExamAttemptRepository {
  constructor(private readonly prisma: PrismaService) {}

  async bulkCreate(input: BulkCreateAttemptInput): Promise<number> {
    if (input.studentIds.length === 0) return 0;
    const result = await this.prisma.examAttempt.createMany({
      data: input.studentIds.map((studentId) => ({
        tenantId: input.tenantId,
        examId: input.examId,
        studentId,
        questionOrderSeed: randomSeed(),
      })),
      skipDuplicates: true, // (examId, studentId) unique
    });
    return result.count;
  }

  async findById(tenantId: string, id: string): Promise<ExamAttemptModel | null> {
    const r = await this.prisma.examAttempt.findFirst({ where: { id, tenantId } });
    return r ? this.toModel(r) : null;
  }

  async findByIdAnyTenant(id: string): Promise<ExamAttemptModel | null> {
    const r = await this.prisma.examAttempt.findUnique({ where: { id } });
    return r ? this.toModel(r) : null;
  }

  async findByExamAndStudent(
    tenantId: string,
    examId: string,
    studentId: string,
  ): Promise<ExamAttemptModel | null> {
    const r = await this.prisma.examAttempt.findFirst({
      where: { tenantId, examId, studentId },
    });
    return r ? this.toModel(r) : null;
  }

  async list(
    filter: ListAttemptsFilter,
  ): Promise<{ data: ExamAttemptModel[]; total: number }> {
    const where: Prisma.ExamAttemptWhereInput = { tenantId: filter.tenantId };
    if (filter.examId) where.examId = filter.examId;
    if (filter.studentId) where.studentId = filter.studentId;
    if (filter.status) where.status = filter.status as PrismaAttemptStatus;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.examAttempt.findMany({
        where,
        take: filter.limit ?? 100,
        skip: filter.offset ?? 0,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.examAttempt.count({ where }),
    ]);
    return { data: rows.map((r) => this.toModel(r)), total };
  }

  async listForStudent(tenantId: string, studentId: string): Promise<ExamAttemptModel[]> {
    const rows = await this.prisma.examAttempt.findMany({
      where: { tenantId, studentId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toModel(r));
  }

  async start(input: {
    tenantId: string;
    id: string;
    timeRemainingSeconds: number;
  }): Promise<ExamAttemptModel> {
    const row = await this.prisma.examAttempt.update({
      where: { id: input.id },
      data: {
        status: 'IN_PROGRESS',
        startedAt: new Date(),
        timeRemainingSeconds: input.timeRemainingSeconds,
      },
    });
    if (row.tenantId !== input.tenantId) throw new NotFoundException('Attempt not found');
    return this.toModel(row);
  }

  async saveProgress(input: {
    tenantId: string;
    id: string;
    timeRemainingSeconds: number;
  }): Promise<ExamAttemptModel> {
    const row = await this.prisma.examAttempt.update({
      where: { id: input.id },
      data: { timeRemainingSeconds: input.timeRemainingSeconds },
    });
    if (row.tenantId !== input.tenantId) throw new NotFoundException('Attempt not found');
    return this.toModel(row);
  }

  async submit(input: {
    tenantId: string;
    id: string;
    autoSubmitted?: boolean;
  }): Promise<ExamAttemptModel> {
    const row = await this.prisma.examAttempt.update({
      where: { id: input.id },
      data: {
        status: 'SUBMITTED',
        submittedAt: new Date(),
        autoSubmitted: input.autoSubmitted ?? false,
        timeRemainingSeconds: 0,
      },
    });
    if (row.tenantId !== input.tenantId) throw new NotFoundException('Attempt not found');
    return this.toModel(row);
  }

  async setStatus(
    tenantId: string,
    id: string,
    status: AttemptStatus,
  ): Promise<ExamAttemptModel> {
    const row = await this.prisma.examAttempt.update({
      where: { id },
      data: { status: status as PrismaAttemptStatus },
    });
    if (row.tenantId !== tenantId) throw new NotFoundException('Attempt not found');
    return this.toModel(row);
  }

  async setGradedScore(input: {
    tenantId: string;
    id: string;
    score: Decimal;
    descriptivePending: boolean;
  }): Promise<ExamAttemptModel> {
    const row = await this.prisma.examAttempt.update({
      where: { id: input.id },
      data: {
        status: 'GRADED',
        score: input.score,
        gradedAt: new Date(),
        descriptivePending: input.descriptivePending,
      },
    });
    if (row.tenantId !== input.tenantId) throw new NotFoundException('Attempt not found');
    return this.toModel(row);
  }

  async incrementViolationCount(
    tenantId: string,
    id: string,
    delta: number,
  ): Promise<ExamAttemptModel> {
    const row = await this.prisma.examAttempt.update({
      where: { id },
      data: { violationCount: { increment: delta } },
    });
    if (row.tenantId !== tenantId) throw new NotFoundException('Attempt not found');
    return this.toModel(row);
  }

  async findExpiredInProgress(now: Date): Promise<ExamAttemptModel[]> {
    // Find IN_PROGRESS attempts where started_at + exam.duration_seconds < now.
    // Prisma can't easily express column-arithmetic in `where`, so use raw query.
    const rows = await this.prisma.$queryRaw<PrismaExamAttempt[]>(Prisma.sql`
      SELECT a.*
      FROM exam_attempts a
      JOIN exams e ON e.id = a.exam_id
      WHERE a.status = 'IN_PROGRESS'
        AND a.started_at IS NOT NULL
        AND a.started_at + (e.duration_seconds * INTERVAL '1 second') < ${now}
      LIMIT 100
    `);
    return rows.map((r) => this.toModel(r));
  }

  // ---------- Answers ----------
  async upsertAnswer(input: UpsertAnswerInput): Promise<AttemptAnswerModel> {
    const row = await this.prisma.attemptAnswer.upsert({
      where: {
        attemptId_examQuestionId: {
          attemptId: input.attemptId,
          examQuestionId: input.examQuestionId,
        },
      },
      update: {
        answerPayload:
          input.answerPayload === null
            ? Prisma.JsonNull
            : (input.answerPayload as Prisma.InputJsonValue),
        ...(input.timeSpentSeconds !== undefined
          ? { timeSpentSeconds: input.timeSpentSeconds }
          : {}),
        ...(input.isFlagged !== undefined ? { isFlaggedByStudent: input.isFlagged } : {}),
      },
      create: {
        tenantId: input.tenantId,
        attemptId: input.attemptId,
        examQuestionId: input.examQuestionId,
        answerPayload:
          input.answerPayload === null
            ? Prisma.JsonNull
            : (input.answerPayload as Prisma.InputJsonValue),
        timeSpentSeconds: input.timeSpentSeconds ?? 0,
        isFlaggedByStudent: input.isFlagged ?? false,
      },
    });
    return this.toAnswer(row);
  }

  async listAnswers(tenantId: string, attemptId: string): Promise<AttemptAnswerModel[]> {
    const rows = await this.prisma.attemptAnswer.findMany({
      where: { tenantId, attemptId },
    });
    return rows.map((r) => this.toAnswer(r));
  }

  async updateAnswerGrading(input: {
    tenantId: string;
    answerId: string;
    isCorrect: boolean | null;
    marksAwarded: Decimal | null;
  }): Promise<void> {
    await this.prisma.attemptAnswer.update({
      where: { id: input.answerId },
      data: { isCorrect: input.isCorrect, marksAwarded: input.marksAwarded },
    });
  }

  // ---------- mappers ----------
  private toModel(r: PrismaExamAttempt): ExamAttemptModel {
    return new ExamAttemptModel(
      r.id,
      r.tenantId,
      r.examId,
      r.studentId,
      r.status as AttemptStatus,
      r.startedAt,
      r.submittedAt,
      r.gradedAt,
      r.timeRemainingSeconds,
      r.score,
      r.autoSubmitted,
      r.questionOrderSeed,
      r.violationCount,
      r.descriptivePending,
      r.createdAt,
      r.updatedAt,
    );
  }

  private toAnswer(r: PrismaAttemptAnswer): AttemptAnswerModel {
    return new AttemptAnswerModel(
      r.id,
      r.tenantId,
      r.attemptId,
      r.examQuestionId,
      r.answerPayload as Record<string, unknown> | null,
      r.isCorrect,
      r.marksAwarded,
      r.timeSpentSeconds,
      r.isFlaggedByStudent,
      r.createdAt,
      r.updatedAt,
    );
  }
}
