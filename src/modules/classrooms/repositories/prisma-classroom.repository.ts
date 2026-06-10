import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  Classroom as PrismaClassroom,
  Student as PrismaStudent,
  User as PrismaUser,
} from '@prisma/client';
import { PrismaService } from '../../../shared/database/prisma.service';
import { Role } from '../../../shared/common/enums/role.enum';
import { UserModel, UserStatus } from '../../users/models/user.model';
import { StudentModel } from '../../students/models/student.model';
import { StudentWithUser } from '../../students/repositories/student.repository';
import { ClassroomModel, ClassroomWithCount } from '../models/classroom.model';
import {
  CreateClassroomInput,
  IClassroomRepository,
  UpdateClassroomInput,
} from './classroom.repository';

@Injectable()
export class PrismaClassroomRepository implements IClassroomRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateClassroomInput): Promise<ClassroomModel> {
    const row = await this.prisma.classroom.create({
      data: {
        tenantId: input.tenantId,
        branchId: input.branchId,
        name: input.name,
        year: input.year ?? null,
        section: input.section ?? null,
        subject: input.subject ?? null,
        createdBy: input.createdBy,
        teachers: input.teacherIds?.length ? {
          create: input.teacherIds.map(id => ({ teacherId: id }))
        } : undefined,
      },
      include: { teachers: { select: { teacherId: true } } },
    });
    return this.toModel(row);
  }

  async findById(tenantId: string, id: string): Promise<ClassroomModel | null> {
    const row = await this.prisma.classroom.findFirst({
      where: { id, tenantId },
      include: { teachers: { select: { teacherId: true } } },
    });
    return row ? this.toModel(row) : null;
  }

  async findByUniqueAttributes(
    tenantId: string,
    branchId: string,
    name: string,
    year?: string | null,
    section?: string | null,
  ): Promise<ClassroomModel | null> {
    const row = await this.prisma.classroom.findFirst({
      where: {
        tenantId,
        branchId,
        name: { equals: name, mode: 'insensitive' },
        year: year || null,
        section: section ? { equals: section, mode: 'insensitive' } : null,
      },
      include: { teachers: { select: { teacherId: true } } },
    });
    return row ? this.toModel(row) : null;
  }

  async findWithCount(tenantId: string, id: string): Promise<ClassroomWithCount | null> {
    const row = await this.prisma.classroom.findFirst({
      where: { id, tenantId },
      include: { _count: { select: { students: true } }, teachers: { select: { teacherId: true } } },
    });
    if (!row) return null;
    return { classroom: this.toModel(row), studentCount: row._count.students };
  }

  async list(
    tenantId: string,
    filters: {
      branchId?: string;
      createdBy?: string;
      name?: string;
      section?: string;
      year?: string;
      subject?: string;
      search?: string;
      limit: number;
      offset: number;
    },
  ): Promise<{ data: ClassroomWithCount[]; total: number }> {
    const where: Prisma.ClassroomWhereInput = { tenantId };
    if (filters.branchId) where.branchId = filters.branchId;
    if (filters.createdBy) {
      where.OR = [
        { createdBy: filters.createdBy },
        { teachers: { some: { teacherId: filters.createdBy } } },
      ];
    }
    if (filters.name) where.name = { contains: filters.name, mode: 'insensitive' };
    if (filters.section) where.section = filters.section;
    if (filters.year) where.year = filters.year;
    if (filters.subject) where.subject = { contains: filters.subject, mode: 'insensitive' };

    if (filters.search) {
      const searchOR: Prisma.ClassroomWhereInput[] = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { subject: { contains: filters.search, mode: 'insensitive' } },
      ];
      where.OR = where.OR ? [{ AND: [ { OR: where.OR }, { OR: searchOR } ] }] : searchOR;
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.classroom.findMany({
        where,
        take: filters.limit,
        skip: filters.offset,
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { students: true } }, teachers: { select: { teacherId: true } } },
      }),
      this.prisma.classroom.count({ where }),
    ]);
    return {
      data: rows.map((r) => ({ classroom: this.toModel(r), studentCount: r._count.students })),
      total,
    };
  }

  async getFilters(
    tenantId: string,
    branchId?: string,
  ): Promise<{ names: string[]; sections: string[]; years: string[]; subjects: string[] }> {
    const where: Prisma.ClassroomWhereInput = { tenantId };
    if (branchId) where.branchId = branchId;

    const [names, sections, years, subjects] = await Promise.all([
      this.prisma.classroom.findMany({ where, select: { name: true }, distinct: ['name'] }),
      this.prisma.classroom.findMany({
        where: { ...where, section: { not: null } },
        select: { section: true },
        distinct: ['section'],
      }),
      this.prisma.classroom.findMany({
        where: { ...where, year: { not: null } },
        select: { year: true },
        distinct: ['year'],
      }),
      this.prisma.classroom.findMany({
        where: { ...where, subject: { not: null } },
        select: { subject: true },
        distinct: ['subject'],
      }),
    ]);

    return {
      names: names.map((n) => n.name).sort(),
      sections: sections.map((s) => s.section!).sort(),
      years: years.map((y) => y.year!).sort((a, b) => b.localeCompare(a)), // Sort years descending
      subjects: subjects.map((s) => s.subject!).sort(),
    };
  }

  async update(tenantId: string, id: string, input: UpdateClassroomInput): Promise<ClassroomModel> {
    const found = await this.prisma.classroom.findFirst({ where: { id, tenantId } });
    if (!found) {
      throw new NotFoundException('Classroom not found');
    }
    const updated = await this.prisma.classroom.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.year !== undefined ? { year: input.year } : {}),
        ...(input.section !== undefined ? { section: input.section } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.teacherIds ? {
          teachers: {
            deleteMany: {},
            create: input.teacherIds.map(id => ({ teacherId: id })),
          }
        } : {}),
      },
      include: { teachers: { select: { teacherId: true } } },
    });
    return this.toModel(updated);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const result = await this.prisma.classroom.deleteMany({ where: { id, tenantId } });
    if (result.count === 0) {
      throw new NotFoundException('Classroom not found');
    }
  }

  async addStudents(
    tenantId: string,
    classroomId: string,
    studentIds: string[],
  ): Promise<{ added: string[]; alreadyMember: string[] }> {
    if (studentIds.length === 0) {
      return { added: [], alreadyMember: [] };
    }
    // Verify classroom + students belong to tenant.
    const classroom = await this.prisma.classroom.findFirst({
      where: { id: classroomId, tenantId },
    });
    if (!classroom) {
      throw new NotFoundException('Classroom not found');
    }
    const validStudents = await this.prisma.student.findMany({
      where: { id: { in: studentIds }, tenantId },
      select: { id: true, rollNo: true },
    });
    const validMap = new Map(validStudents.map((s) => [s.id, s.rollNo]));
    const validIds = new Set(validMap.keys());

    // Exclude anyone already in THIS classroom
    const existing = await this.prisma.classroomStudent.findMany({
      where: { studentId: { in: studentIds }, classroomId },
      select: { studentId: true },
    });
    const alreadyMember = new Set(existing.map((e) => e.studentId));

    const toAdd = studentIds.filter((id) => validIds.has(id) && !alreadyMember.has(id));
    if (toAdd.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        const currentCount = await tx.classroomStudent.count({ where: { classroomId } });

        await tx.classroomStudent.createMany({
          data: toAdd.map((studentId) => ({ classroomId, studentId })),
          skipDuplicates: true,
        });

        // Generate Roll Numbers
        const yy = classroom.year ? classroom.year.slice(-2) : '00';
        const batchStr = classroom.name ? classroom.name.slice(0, 2).toUpperCase() : 'XX';
        const sectionStr = classroom.section ? classroom.section.toUpperCase() : 'X';

        let generatedCount = 0;
        for (let i = 0; i < toAdd.length; i++) {
          const studentId = toAdd[i];
          const studentRollNo = validMap.get(studentId);

          if (!studentRollNo) {
            const countStr = String(currentCount + generatedCount + 1).padStart(2, '0');
            const newRollNo = `${yy}${batchStr}${sectionStr}${countStr}`;
            await tx.student.update({
              where: { id: studentId },
              data: { rollNo: newRollNo },
            });
            generatedCount++;
          }
        }
      });
    }
    return {
      added: toAdd,
      alreadyMember: Array.from(alreadyMember),
    };
  }

  async removeStudent(tenantId: string, classroomId: string, studentId: string): Promise<boolean> {
    const classroom = await this.prisma.classroom.findFirst({
      where: { id: classroomId, tenantId },
    });
    if (!classroom) {
      throw new NotFoundException('Classroom not found');
    }
    const r = await this.prisma.classroomStudent.deleteMany({
      where: { classroomId, studentId },
    });
    return r.count > 0;
  }

  async listStudents(
    tenantId: string,
    classroomId: string,
    limit: number,
    offset: number,
  ): Promise<{ data: StudentWithUser[]; total: number }> {
    const classroom = await this.prisma.classroom.findFirst({
      where: { id: classroomId, tenantId },
    });
    if (!classroom) {
      throw new NotFoundException('Classroom not found');
    }
    const where: Prisma.ClassroomStudentWhereInput = { classroomId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.classroomStudent.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { joinedAt: 'desc' },
        include: { student: { include: { user: true } } },
      }),
      this.prisma.classroomStudent.count({ where }),
    ]);
    return {
      data: rows.map((r) => ({
        student: this.toStudent(r.student),
        user: this.toUser(r.student.user),
      })),
      total,
    };
  }

  private toModel(r: PrismaClassroom & { teachers?: { teacherId: string }[] }): ClassroomModel {
    return new ClassroomModel(
      r.id,
      r.tenantId,
      r.branchId,
      r.name,
      r.year,
      r.section,
      r.subject,
      r.createdBy,
      r.createdAt,
      r.updatedAt,
      r.teachers?.map(t => t.teacherId) || [],
    );
  }

  private toStudent(s: PrismaStudent): StudentModel {
    return new StudentModel(
      s.id,
      s.tenantId,
      s.userId,
      s.branchId,
      s.classLabel,
      s.rollNo,
      s.parentContact,
      s.createdAt,
      s.updatedAt,
    );
  }

  private toUser(u: PrismaUser): UserModel {
    return new UserModel(
      u.id,
      u.tenantId,
      u.branchId,
      u.email,
      u.phone,
      u.passwordHash,
      u.name,
      u.role as Role,
      u.status as UserStatus,
      u.lastLoginAt,
      u.createdAt,
      u.updatedAt,
    );
  }
}
