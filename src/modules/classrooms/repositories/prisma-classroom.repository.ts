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
      },
    });
    return this.toModel(row);
  }

  async findById(tenantId: string, id: string): Promise<ClassroomModel | null> {
    const row = await this.prisma.classroom.findFirst({ where: { id, tenantId } });
    return row ? this.toModel(row) : null;
  }

  async findWithCount(tenantId: string, id: string): Promise<ClassroomWithCount | null> {
    const row = await this.prisma.classroom.findFirst({
      where: { id, tenantId },
      include: { _count: { select: { students: true } } },
    });
    if (!row) return null;
    return { classroom: this.toModel(row), studentCount: row._count.students };
  }

  async list(
    tenantId: string,
    filters: { branchId?: string; createdBy?: string; limit: number; offset: number },
  ): Promise<{ data: ClassroomWithCount[]; total: number }> {
    const where: Prisma.ClassroomWhereInput = { tenantId };
    if (filters.branchId) where.branchId = filters.branchId;
    if (filters.createdBy) where.createdBy = filters.createdBy;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.classroom.findMany({
        where,
        take: filters.limit,
        skip: filters.offset,
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { students: true } } },
      }),
      this.prisma.classroom.count({ where }),
    ]);
    return {
      data: rows.map((r) => ({ classroom: this.toModel(r), studentCount: r._count.students })),
      total,
    };
  }

  async update(
    tenantId: string,
    id: string,
    input: UpdateClassroomInput,
  ): Promise<ClassroomModel> {
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
      },
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
      select: { id: true },
    });
    const validIds = new Set(validStudents.map((s) => s.id));

    const existing = await this.prisma.classroomStudent.findMany({
      where: { classroomId, studentId: { in: studentIds } },
      select: { studentId: true },
    });
    const alreadyMember = new Set(existing.map((e) => e.studentId));

    const toAdd = studentIds.filter((id) => validIds.has(id) && !alreadyMember.has(id));
    if (toAdd.length > 0) {
      await this.prisma.classroomStudent.createMany({
        data: toAdd.map((studentId) => ({ classroomId, studentId })),
        skipDuplicates: true,
      });
    }
    return {
      added: toAdd,
      alreadyMember: Array.from(alreadyMember),
    };
  }

  async removeStudent(
    tenantId: string,
    classroomId: string,
    studentId: string,
  ): Promise<boolean> {
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

  private toModel(r: PrismaClassroom): ClassroomModel {
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
