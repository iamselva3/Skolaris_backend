import { Injectable } from '@nestjs/common';
import { Prisma, User as PrismaUser, Role as PrismaRole } from '@prisma/client';
import { PrismaService } from '../../../shared/database/prisma.service';
import { Role } from '../../../shared/common/enums/role.enum';
import { UserModel, UserStatus } from '../models/user.model';
import {
  CreateUserInput,
  IUserRepository,
  ListUsersFilter,
  UpdateUserInput,
} from './user.repository';

@Injectable()
export class PrismaUserRepository implements IUserRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateUserInput): Promise<UserModel> {
    const row = await this.prisma.user.create({
      data: {
        tenantId: input.tenantId,
        branchId: input.branchId ?? null,
        email: input.email,
        phone: input.phone,
        passwordHash: input.passwordHash,
        name: input.name,
        role: input.role as PrismaRole,
      },
    });
    return this.toModel(row);
  }

  async findById(tenantId: string, id: string): Promise<UserModel | null> {
    const row = await this.prisma.user.findFirst({ where: { id, tenantId } });
    return row ? this.toModel(row) : null;
  }

  async findByIdAnyTenant(id: string): Promise<UserModel | null> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    return row ? this.toModel(row) : null;
  }

  async findByEmail(tenantId: string, email: string): Promise<UserModel | null> {
    const row = await this.prisma.user.findFirst({ where: { tenantId, email } });
    return row ? this.toModel(row) : null;
  }

  async findByEmailGlobal(email: string): Promise<UserModel | null> {
    const row = await this.prisma.user.findFirst({ where: { email } });
    return row ? this.toModel(row) : null;
  }

  async list(filter: ListUsersFilter): Promise<{ data: UserModel[]; total: number }> {
    const where: Prisma.UserWhereInput = { tenantId: filter.tenantId };
    if (filter.role) where.role = filter.role as PrismaRole;
    if (filter.branchId !== undefined) where.branchId = filter.branchId;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        take: filter.limit ?? 50,
        skip: filter.offset ?? 0,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    return { data: rows.map((r) => this.toModel(r)), total };
  }

  async update(tenantId: string, id: string, input: UpdateUserInput): Promise<UserModel> {
    const data: Prisma.UserUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.phone !== undefined) data.phone = input.phone;
    if (input.passwordHash !== undefined) data.passwordHash = input.passwordHash;
    if (input.branchId !== undefined) {
      data.branch =
        input.branchId === null ? { disconnect: true } : { connect: { id: input.branchId } };
    }
    if (input.status !== undefined) data.status = input.status;

    const row = await this.prisma.user.update({
      where: { id },
      data,
    });
    if (row.tenantId !== tenantId) {
      throw new Error('Tenant mismatch on user update');
    }
    return this.toModel(row);
  }

  async disable(tenantId: string, id: string): Promise<void> {
    await this.prisma.user.updateMany({
      where: { id, tenantId },
      data: { status: 'DISABLED' },
    });
  }

  async recordLogin(id: string): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: { lastLoginAt: new Date() },
    });
  }

  private toModel(r: PrismaUser): UserModel {
    return new UserModel(
      r.id,
      r.tenantId,
      r.branchId,
      r.email,
      r.phone,
      r.passwordHash,
      r.name,
      r.role as Role,
      r.status as UserStatus,
      r.lastLoginAt,
      r.createdAt,
      r.updatedAt,
    );
  }
}
