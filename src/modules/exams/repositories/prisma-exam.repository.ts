import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Exam as PrismaExam,
  ExamAssignment as PrismaExamAssignment,
  ExamQuestion as PrismaExamQuestion,
  ExamSection as PrismaExamSection,
  ExamStatus as PrismaExamStatus,
  Prisma,
  TestMode as PrismaTestMode,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../../shared/database/prisma.service';
import {
  AntiCheatConfig,
  DEFAULT_ANTI_CHEAT_CONFIG,
  ExamModel,
  ExamStatus,
  TestMode,
} from '../models/exam.model';
import { ExamAssignmentModel } from '../models/exam-assignment.model';
import { ExamQuestionModel } from '../models/exam-question.model';
import { ExamSectionModel } from '../models/exam-section.model';
import {
  CreateExamInput,
  ExamDetail,
  IExamRepository,
  ListExamsFilter,
  UpdateExamInput,
} from './exam.repository';

@Injectable()
export class PrismaExamRepository implements IExamRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateExamInput): Promise<ExamModel> {
    const antiCheat = { ...DEFAULT_ANTI_CHEAT_CONFIG, ...(input.antiCheatConfig ?? {}) };
    const row = await this.prisma.exam.create({
      data: {
        tenantId: input.tenantId,
        createdBy: input.createdBy,
        title: input.title,
        description: input.description ?? null,
        durationSeconds: input.durationSeconds,
        defaultNegativeMarks: input.defaultNegativeMarks ?? 0,
        randomizeQuestions: input.randomizeQuestions ?? false,
        randomizeOptions: input.randomizeOptions ?? false,
        opensAt: input.opensAt ?? null,
        closesAt: input.closesAt ?? null,
        testMode: (input.testMode ?? 'ONLINE') as PrismaTestMode,
        programId: input.programId ?? null,
        subjectId: input.subjectId ?? null,
        antiCheatConfig: antiCheat as unknown as Prisma.InputJsonValue,
      },
    });
    return this.toModel(row);
  }

  async findById(tenantId: string, id: string): Promise<ExamModel | null> {
    const row = await this.prisma.exam.findFirst({ where: { id, tenantId } });
    return row ? this.toModel(row) : null;
  }

  async findByIdAnyTenant(id: string): Promise<ExamModel | null> {
    const row = await this.prisma.exam.findUnique({ where: { id } });
    return row ? this.toModel(row) : null;
  }

  async findDetail(tenantId: string, id: string): Promise<ExamDetail | null> {
    const row = await this.prisma.exam.findFirst({
      where: { id, tenantId },
      include: {
        sections: { orderBy: { position: 'asc' } },
        questions: { orderBy: { position: 'asc' } },
        assignments: true,
      },
    });
    if (!row) return null;
    return {
      exam: this.toModel(row),
      sections: row.sections.map((s) => this.toSection(s)),
      questions: row.questions.map((q) => this.toExamQuestion(q)),
      assignments: row.assignments.map((a) => this.toAssignment(a)),
    };
  }

  async list(filter: ListExamsFilter): Promise<{ data: ExamModel[]; total: number }> {
    const where: Prisma.ExamWhereInput = { tenantId: filter.tenantId };
    if (filter.status) where.status = filter.status as PrismaExamStatus;
    if (filter.createdBy) where.createdBy = filter.createdBy;
    if (filter.programId) where.programId = filter.programId;
    if (filter.subjectId) where.subjectId = filter.subjectId;
    if (filter.q && filter.q.length > 0) {
      where.OR = [
        { title: { contains: filter.q, mode: 'insensitive' } },
        { description: { contains: filter.q, mode: 'insensitive' } },
      ];
    }
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.exam.findMany({
        where,
        take: filter.limit,
        skip: filter.offset,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.exam.count({ where }),
    ]);
    return { data: rows.map((r) => this.toModel(r)), total };
  }

  async update(
    tenantId: string,
    id: string,
    input: UpdateExamInput,
  ): Promise<ExamModel> {
    const found = await this.prisma.exam.findFirst({ where: { id, tenantId } });
    if (!found) throw new NotFoundException('Exam not found');
    const data: Prisma.ExamUncheckedUpdateInput = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if (input.durationSeconds !== undefined) data.durationSeconds = input.durationSeconds;
    if (input.defaultNegativeMarks !== undefined) data.defaultNegativeMarks = input.defaultNegativeMarks;
    if (input.randomizeQuestions !== undefined) data.randomizeQuestions = input.randomizeQuestions;
    if (input.randomizeOptions !== undefined) data.randomizeOptions = input.randomizeOptions;
    if (input.opensAt !== undefined) data.opensAt = input.opensAt;
    if (input.closesAt !== undefined) data.closesAt = input.closesAt;
    if (input.programId !== undefined) data.programId = input.programId;
    if (input.subjectId !== undefined) data.subjectId = input.subjectId;
    if (input.antiCheatConfig !== undefined) {
      const current = (found.antiCheatConfig as unknown as AntiCheatConfig) ?? DEFAULT_ANTI_CHEAT_CONFIG;
      data.antiCheatConfig = { ...current, ...input.antiCheatConfig } as unknown as Prisma.InputJsonValue;
    }
    const row = await this.prisma.exam.update({ where: { id }, data });
    return this.toModel(row);
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const r = await this.prisma.exam.deleteMany({ where: { id, tenantId } });
    if (r.count === 0) throw new NotFoundException('Exam not found');
  }

  async setStatus(
    tenantId: string,
    id: string,
    status: ExamStatus,
    publishedAt?: Date | null,
  ): Promise<ExamModel> {
    const row = await this.prisma.exam.update({
      where: { id },
      data: {
        status: status as PrismaExamStatus,
        ...(publishedAt !== undefined ? { publishedAt } : {}),
      },
    });
    if (row.tenantId !== tenantId) throw new NotFoundException('Exam not found');
    return this.toModel(row);
  }

  async recomputeTotalMarks(tenantId: string, id: string): Promise<Decimal> {
    const sum = await this.prisma.examQuestion.aggregate({
      where: { tenantId, examId: id },
      _sum: { marks: true },
    });
    const total = sum._sum.marks ?? new Decimal(0);
    await this.prisma.exam.update({ where: { id }, data: { totalMarks: total } });
    return total;
  }

  async createSection(input: {
    tenantId: string;
    examId: string;
    name: string;
    position: number;
    timeLimitSeconds?: number | null;
  }): Promise<ExamSectionModel> {
    const row = await this.prisma.examSection.create({
      data: {
        tenantId: input.tenantId,
        examId: input.examId,
        name: input.name,
        position: input.position,
        timeLimitSeconds: input.timeLimitSeconds ?? null,
      },
    });
    return this.toSection(row);
  }

  async updateSection(
    tenantId: string,
    id: string,
    input: { name?: string; position?: number; timeLimitSeconds?: number | null },
  ): Promise<ExamSectionModel> {
    const found = await this.prisma.examSection.findFirst({ where: { id, tenantId } });
    if (!found) throw new NotFoundException('Section not found');
    const row = await this.prisma.examSection.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        ...(input.timeLimitSeconds !== undefined ? { timeLimitSeconds: input.timeLimitSeconds } : {}),
      },
    });
    return this.toSection(row);
  }

  async deleteSection(tenantId: string, id: string): Promise<void> {
    const r = await this.prisma.examSection.deleteMany({ where: { id, tenantId } });
    if (r.count === 0) throw new NotFoundException('Section not found');
  }

  async addExamQuestions(input: {
    tenantId: string;
    examId: string;
    items: Array<{
      questionId: string;
      sectionId?: string | null;
      position: number;
      marks: number;
      negativeMarks?: number;
    }>;
  }): Promise<ExamQuestionModel[]> {
    if (input.items.length === 0) return [];
    // Verify all questions belong to the same tenant.
    const validQuestions = await this.prisma.question.findMany({
      where: { id: { in: input.items.map((i) => i.questionId) }, tenantId: input.tenantId },
      select: { id: true },
    });
    const validIds = new Set(validQuestions.map((q) => q.id));
    const filtered = input.items.filter((i) => validIds.has(i.questionId));

    if (filtered.length === 0) return [];
    return this.prisma.$transaction(async (tx) => {
      await tx.examQuestion.createMany({
        data: filtered.map((i) => ({
          tenantId: input.tenantId,
          examId: input.examId,
          sectionId: i.sectionId ?? null,
          questionId: i.questionId,
          position: i.position,
          marks: i.marks,
          negativeMarks: i.negativeMarks ?? 0,
        })),
        skipDuplicates: true, // (examId, questionId) unique
      });
      const rows = await tx.examQuestion.findMany({
        where: { examId: input.examId, questionId: { in: filtered.map((i) => i.questionId) } },
        orderBy: { position: 'asc' },
      });
      return rows.map((r) => this.toExamQuestion(r));
    });
  }

  async updateExamQuestion(
    tenantId: string,
    id: string,
    input: {
      position?: number;
      marks?: number;
      negativeMarks?: number;
      sectionId?: string | null;
    },
  ): Promise<ExamQuestionModel> {
    const found = await this.prisma.examQuestion.findFirst({ where: { id, tenantId } });
    if (!found) throw new NotFoundException('Exam question not found');
    const row = await this.prisma.examQuestion.update({
      where: { id },
      data: {
        ...(input.position !== undefined ? { position: input.position } : {}),
        ...(input.marks !== undefined ? { marks: input.marks } : {}),
        ...(input.negativeMarks !== undefined ? { negativeMarks: input.negativeMarks } : {}),
        ...(input.sectionId !== undefined ? { sectionId: input.sectionId } : {}),
      },
    });
    return this.toExamQuestion(row);
  }

  async removeExamQuestion(
    tenantId: string,
    id: string,
  ): Promise<{ examId: string }> {
    const row = await this.prisma.examQuestion.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('Exam question not found');
    await this.prisma.examQuestion.delete({ where: { id } });
    return { examId: row.examId };
  }

  async createAssignments(input: {
    tenantId: string;
    examId: string;
    classroomIds: string[];
    studentIds: string[];
  }): Promise<ExamAssignmentModel[]> {
    const rows: PrismaExamAssignment[] = [];
    const classroomData = input.classroomIds.map((cid) => ({
      tenantId: input.tenantId,
      examId: input.examId,
      classroomId: cid,
      studentId: null,
    }));
    const studentData = input.studentIds.map((sid) => ({
      tenantId: input.tenantId,
      examId: input.examId,
      classroomId: null,
      studentId: sid,
    }));
    if (classroomData.length + studentData.length === 0) return [];
    await this.prisma.examAssignment.createMany({ data: [...classroomData, ...studentData] });
    rows.push(
      ...(await this.prisma.examAssignment.findMany({
        where: { tenantId: input.tenantId, examId: input.examId },
      })),
    );
    return rows.map((r) => this.toAssignment(r));
  }

  async expandAssignmentsToStudentIds(tenantId: string, examId: string): Promise<string[]> {
    const assignments = await this.prisma.examAssignment.findMany({
      where: { tenantId, examId },
      include: {
        classroom: {
          include: { students: { include: { student: { select: { id: true } } } } },
        },
      },
    });
    const set = new Set<string>();
    for (const a of assignments) {
      if (a.studentId) set.add(a.studentId);
      if (a.classroom) {
        for (const cs of a.classroom.students) {
          set.add(cs.student.id);
        }
      }
    }
    return Array.from(set);
  }

  // ----- mappers --------------------------------------------------------
  private toModel(r: PrismaExam): ExamModel {
    return new ExamModel(
      r.id,
      r.tenantId,
      r.createdBy,
      r.title,
      r.description,
      r.durationSeconds,
      r.totalMarks,
      r.defaultNegativeMarks,
      r.randomizeQuestions,
      r.randomizeOptions,
      r.status as ExamStatus,
      r.opensAt,
      r.closesAt,
      r.testMode as TestMode,
      r.publishedAt,
      (r.antiCheatConfig as unknown as AntiCheatConfig) ?? DEFAULT_ANTI_CHEAT_CONFIG,
      r.programId,
      r.subjectId,
      r.createdAt,
      r.updatedAt,
    );
  }

  private toSection(r: PrismaExamSection): ExamSectionModel {
    return new ExamSectionModel(r.id, r.tenantId, r.examId, r.name, r.position, r.timeLimitSeconds);
  }

  private toExamQuestion(r: PrismaExamQuestion): ExamQuestionModel {
    return new ExamQuestionModel(
      r.id,
      r.tenantId,
      r.examId,
      r.sectionId,
      r.questionId,
      r.position,
      r.marks,
      r.negativeMarks,
    );
  }

  private toAssignment(r: PrismaExamAssignment): ExamAssignmentModel {
    return new ExamAssignmentModel(r.id, r.tenantId, r.examId, r.classroomId, r.studentId);
  }
}
