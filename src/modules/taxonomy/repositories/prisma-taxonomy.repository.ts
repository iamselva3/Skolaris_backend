import { Injectable } from '@nestjs/common';
import {
  Chapter as PrismaChapter,
  Program as PrismaProgram,
  Subject as PrismaSubject,
  Topic as PrismaTopic,
} from '@prisma/client';
import { PrismaService } from '../../../shared/database/prisma.service';
import { ChapterModel, ProgramModel, SubjectModel, TopicModel } from '../models/taxonomy.models';
import { ITaxonomyRepository, ListSubjectsFilter } from './taxonomy.repository';

@Injectable()
export class PrismaTaxonomyRepository implements ITaxonomyRepository {
  constructor(private readonly prisma: PrismaService) {}

  /* ─── programs ─── */

  async listPrograms(tenantId: string): Promise<ProgramModel[]> {
    const rows = await this.prisma.program.findMany({
      where: { tenantId },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return rows.map(toProgram);
  }

  async getProgram(tenantId: string, id: string): Promise<ProgramModel | null> {
    const row = await this.prisma.program.findFirst({ where: { id, tenantId } });
    return row ? toProgram(row) : null;
  }

  async getProgramByCode(tenantId: string, code: string): Promise<ProgramModel | null> {
    const row = await this.prisma.program.findUnique({
      where: { tenantId_code: { tenantId, code } },
    });
    return row ? toProgram(row) : null;
  }

  async createProgram(input: {
    tenantId: string;
    code: string;
    name: string;
  }): Promise<ProgramModel> {
    const row = await this.prisma.program.create({ data: input });
    return toProgram(row);
  }

  async updateProgram(
    tenantId: string,
    id: string,
    patch: { name?: string; isActive?: boolean },
  ): Promise<ProgramModel> {
    await this.prisma.program.updateMany({ where: { id, tenantId }, data: patch });
    const row = await this.prisma.program.findUniqueOrThrow({ where: { id } });
    return toProgram(row);
  }

  /* ─── subjects ─── */

  async listSubjects(filter: ListSubjectsFilter): Promise<SubjectModel[]> {
    const rows = await this.prisma.subject.findMany({
      where: {
        tenantId: filter.tenantId,
        programId: filter.programId,
        isActive: filter.isActive,
      },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: { program: { select: { id: true, code: true, name: true } } },
    });
    return rows.map(toSubject);
  }

  async getSubject(tenantId: string, id: string): Promise<SubjectModel | null> {
    const row = await this.prisma.subject.findFirst({
      where: { id, tenantId },
      include: { program: { select: { id: true, code: true, name: true } } },
    });
    return row ? toSubject(row) : null;
  }

  async createSubject(input: {
    tenantId: string;
    programId: string;
    name: string;
  }): Promise<SubjectModel> {
    const row = await this.prisma.subject.create({
      data: input,
      include: { program: { select: { id: true, code: true, name: true } } },
    });
    return toSubject(row);
  }

  async updateSubject(
    tenantId: string,
    id: string,
    patch: { name?: string; isActive?: boolean },
  ): Promise<SubjectModel> {
    await this.prisma.subject.updateMany({ where: { id, tenantId }, data: patch });
    const row = await this.prisma.subject.findUniqueOrThrow({
      where: { id },
      include: { program: { select: { id: true, code: true, name: true } } },
    });
    return toSubject(row);
  }

  /* ─── teacher_subjects ─── */

  async listSubjectsForTeacher(tenantId: string, userId: string): Promise<SubjectModel[]> {
    const rows = await this.prisma.subject.findMany({
      where: { tenantId, teachers: { some: { userId } } },
      orderBy: [{ name: 'asc' }],
      include: { program: { select: { id: true, code: true, name: true } } },
    });
    return rows.map(toSubject);
  }

  async assignTeacherSubjects(input: {
    tenantId: string;
    userId: string;
    subjectIds: string[];
  }): Promise<void> {
    // Validate that the subjects belong to this tenant before assigning.
    const subjects = await this.prisma.subject.findMany({
      where: { id: { in: input.subjectIds }, tenantId: input.tenantId },
      select: { id: true },
    });
    const valid = new Set(subjects.map((s) => s.id));
    const toAssign = input.subjectIds.filter((id) => valid.has(id));
    await this.prisma.$transaction(
      toAssign.map((subjectId) =>
        this.prisma.teacherSubject.upsert({
          where: { userId_subjectId: { userId: input.userId, subjectId } },
          update: {},
          create: { userId: input.userId, subjectId },
        }),
      ),
    );
  }

  /* ─── topics (leaf, child of Chapter) ─── */

  async listTopics(tenantId: string, chapterId?: string): Promise<TopicModel[]> {
    const rows = await this.prisma.topic.findMany({
      where: { tenantId, chapterId },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toTopic);
  }

  async getTopic(tenantId: string, id: string): Promise<TopicModel | null> {
    const row = await this.prisma.topic.findFirst({ where: { id, tenantId } });
    return row ? toTopic(row) : null;
  }

  async createTopic(input: {
    tenantId: string;
    chapterId: string;
    name: string;
    position?: number;
  }): Promise<TopicModel> {
    const row = await this.prisma.topic.create({
      data: { ...input, position: input.position ?? 0 },
    });
    return toTopic(row);
  }

  async updateTopic(
    tenantId: string,
    id: string,
    patch: { name?: string; position?: number },
  ): Promise<TopicModel> {
    await this.prisma.topic.updateMany({ where: { id, tenantId }, data: patch });
    const row = await this.prisma.topic.findUniqueOrThrow({ where: { id } });
    return toTopic(row);
  }

  async deleteTopic(tenantId: string, id: string): Promise<void> {
    await this.prisma.topic.deleteMany({ where: { id, tenantId } });
  }

  /* ─── chapters (mid-level, child of Subject) ─── */

  async listChapters(tenantId: string, subjectId?: string): Promise<ChapterModel[]> {
    const rows = await this.prisma.chapter.findMany({
      where: { tenantId, subjectId },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toChapter);
  }

  async getChapter(tenantId: string, id: string): Promise<ChapterModel | null> {
    const row = await this.prisma.chapter.findFirst({ where: { id, tenantId } });
    return row ? toChapter(row) : null;
  }

  async createChapter(input: {
    tenantId: string;
    subjectId: string;
    name: string;
    position?: number;
  }): Promise<ChapterModel> {
    const row = await this.prisma.chapter.create({
      data: { ...input, position: input.position ?? 0 },
    });
    return toChapter(row);
  }

  async updateChapter(
    tenantId: string,
    id: string,
    patch: { name?: string; position?: number },
  ): Promise<ChapterModel> {
    await this.prisma.chapter.updateMany({ where: { id, tenantId }, data: patch });
    const row = await this.prisma.chapter.findUniqueOrThrow({ where: { id } });
    return toChapter(row);
  }

  async deleteChapter(tenantId: string, id: string): Promise<void> {
    await this.prisma.chapter.deleteMany({ where: { id, tenantId } });
  }
}

/* ─── mappers ─── */

function toProgram(r: PrismaProgram): ProgramModel {
  return new ProgramModel(r.id, r.tenantId, r.code, r.name, r.isActive, r.createdAt, r.updatedAt);
}

type SubjectWithProgram = PrismaSubject & {
  program?: { id: string; code: string; name: string } | null;
};

function toSubject(r: SubjectWithProgram): SubjectModel {
  return new SubjectModel(
    r.id,
    r.tenantId,
    r.programId,
    r.name,
    r.isActive,
    r.createdAt,
    r.updatedAt,
    r.program ?? null,
  );
}

function toTopic(r: PrismaTopic): TopicModel {
  return new TopicModel(
    r.id,
    r.tenantId,
    r.chapterId,
    r.name,
    r.position,
    r.createdAt,
    r.updatedAt,
  );
}

function toChapter(r: PrismaChapter): ChapterModel {
  return new ChapterModel(
    r.id,
    r.tenantId,
    r.subjectId,
    r.name,
    r.position,
    r.createdAt,
    r.updatedAt,
  );
}
