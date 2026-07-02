import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  Student as PrismaStudent,
  User as PrismaUser,
  Role as PrismaRole,
} from '@prisma/client';
import { PrismaService } from '../../../shared/database/prisma.service';
import { Role } from '../../../shared/common/enums/role.enum';
import { UserModel, UserStatus } from '../../users/models/user.model';
import { StudentModel } from '../models/student.model';
import {
  CreateStudentInput,
  IStudentRepository,
  ListStudentsFilter,
  StudentWithUser,
  UpdateStudentInput,
} from './student.repository';

@Injectable()
export class PrismaStudentRepository implements IStudentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createWithUser(input: CreateStudentInput): Promise<StudentWithUser> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          tenantId: input.tenantId,
          branchId: input.branchId ?? null,
          email: input.user.email,
          passwordHash: input.user.passwordHash,
          name: input.user.name,
          role: PrismaRole.STUDENT,
        },
      });
      const student = await tx.student.create({
        data: {
          tenantId: input.tenantId,
          userId: user.id,
          branchId: input.branchId ?? null,
          classLabel: input.classLabel ?? null,
          rollNo: input.rollNo ?? null,
          parentContact: input.parentContact ?? null,
        },
      });
      return { student: this.toStudent(student), user: this.toUser(user) };
    });
  }

  async findById(tenantId: string, id: string): Promise<StudentWithUser | null> {
    const row = await this.prisma.student.findFirst({
      where: { id, tenantId },
      include: { user: true, classrooms: { include: { classroom: true } } },
    });
    return row ? { student: this.toStudent(row), user: this.toUser(row.user) } : null;
  }

  async findByUserId(tenantId: string, userId: string): Promise<StudentWithUser | null> {
    const row = await this.prisma.student.findFirst({
      where: { tenantId, userId },
      include: { user: true, classrooms: { include: { classroom: true } } },
    });
    return row ? { student: this.toStudent(row), user: this.toUser(row.user) } : null;
  }

  async list(filter: ListStudentsFilter): Promise<{ data: StudentWithUser[]; total: number }> {
    const where: Prisma.StudentWhereInput = { tenantId: filter.tenantId };
    if (filter.unallocated) {
      where.classrooms = { none: {} };
    } else if (
      (filter.year && filter.year.length > 0) ||
      (filter.subject && filter.subject.length > 0) ||
      (filter.batch && filter.batch.length > 0) ||
      (filter.section && filter.section.length > 0)
    ) {
      // Hierarchy (Academic Year → Discipline → Batch → Section) maps to classroom
      // columns (year/subject/name/section) resolved via membership. Any subset of
      // levels narrows the set, so a partial hierarchy (e.g. year+discipline only)
      // still filters.
      where.classrooms = {
        some: {
          classroom: {
            ...(filter.year && filter.year.length > 0 ? { year: { in: filter.year } } : {}),
            ...(filter.batch && filter.batch.length > 0 ? { name: { in: filter.batch } } : {}),
            ...(filter.section && filter.section.length > 0 ? { section: { in: filter.section } } : {}),
            ...(filter.subject && filter.subject.length > 0 ? { subject: { in: filter.subject } } : {}),
          },
        },
      };
    }
    if (filter.branchId) where.branchId = filter.branchId;
    if (filter.q && filter.q.length > 0) {
      where.OR = [
        { rollNo: { contains: filter.q, mode: 'insensitive' } },
        { user: { name: { contains: filter.q, mode: 'insensitive' } } },
        { user: { email: { contains: filter.q, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.student.findMany({
        where,
        include: { user: true, classrooms: { include: { classroom: true } } },
        take: filter.limit,
        skip: filter.offset,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.student.count({ where }),
    ]);
    return {
      data: rows.map((r) => ({ student: this.toStudent(r), user: this.toUser(r.user) })),
      total,
    };
  }

  async update(tenantId: string, id: string, input: UpdateStudentInput): Promise<StudentWithUser> {
    const found = await this.prisma.student.findFirst({ where: { id, tenantId } });
    if (!found) {
      throw new NotFoundException('Student not found');
    }
    const updated = await this.prisma.student.update({
      where: { id },
      data: {
        ...(input.classLabel !== undefined ? { classLabel: input.classLabel } : {}),
        ...(input.rollNo !== undefined ? { rollNo: input.rollNo } : {}),
        ...(input.parentContact !== undefined ? { parentContact: input.parentContact } : {}),
        ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      },
      include: { user: true, classrooms: { include: { classroom: true } } },
    });
    return { student: this.toStudent(updated), user: this.toUser(updated.user) };
  }

  async disable(tenantId: string, id: string): Promise<void> {
    const row = await this.prisma.student.findFirst({
      where: { id, tenantId },
      include: { user: true },
    });
    if (!row) {
      throw new NotFoundException('Student not found');
    }
    await this.prisma.user.update({
      where: { id: row.userId },
      data: { status: 'DISABLED' },
    });
  }

  private toStudent(r: PrismaStudent & { classrooms?: any[] }): StudentModel {
    const firstClassroom = r.classrooms?.[0]?.classroom;
    return new StudentModel(
      r.id,
      r.tenantId,
      r.userId,
      r.branchId,
      r.classLabel,
      r.rollNo,
      r.parentContact,
      r.createdAt,
      r.updatedAt,
      firstClassroom?.name ?? null,
      firstClassroom?.section ?? null,
      firstClassroom?.subject ?? null,
      firstClassroom?.year ?? null,
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
