import { Injectable } from '@nestjs/common';
import { Tenant as PrismaTenant, User as PrismaUser, Role as PrismaRole } from '@prisma/client';
import { PrismaService } from '../../../shared/database/prisma.service';
import { Role } from '../../../shared/common/enums/role.enum';
import { UserModel, UserStatus } from '../../users/models/user.model';
import { TenantModel, TenantStatus } from '../models/tenant.model';
import {
  CreateTenantWithAdminInput,
  ITenantRepository,
  UpdateTenantInput,
} from './tenant.repository';

@Injectable()
export class PrismaTenantRepository implements ITenantRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createWithAdmin(
    input: CreateTenantWithAdminInput,
  ): Promise<{ tenant: TenantModel; admin: UserModel }> {
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name: input.name, slug: input.slug },
      });
      const admin = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: input.admin.email,
          passwordHash: input.admin.passwordHash,
          name: input.admin.name,
          role: PrismaRole.SUPER_ADMIN,
        },
      });
      return { tenant: this.toTenant(tenant), admin: this.toUser(admin) };
    });
  }

  async findById(id: string): Promise<TenantModel | null> {
    const row = await this.prisma.tenant.findUnique({ where: { id } });
    return row ? this.toTenant(row) : null;
  }

  async findBySlug(slug: string): Promise<TenantModel | null> {
    const row = await this.prisma.tenant.findUnique({ where: { slug } });
    return row ? this.toTenant(row) : null;
  }

  async list(limit: number, offset: number): Promise<{ data: TenantModel[]; total: number }> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.tenant.findMany({ take: limit, skip: offset, orderBy: { createdAt: 'desc' } }),
      this.prisma.tenant.count(),
    ]);
    return { data: rows.map((r) => this.toTenant(r)), total };
  }

  async update(id: string, input: UpdateTenantInput): Promise<TenantModel> {
    const row = await this.prisma.tenant.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
    });
    return this.toTenant(row);
  }

  private toTenant(r: PrismaTenant): TenantModel {
    return new TenantModel(
      r.id,
      r.name,
      r.slug,
      r.status as TenantStatus,
      r.createdAt,
      r.updatedAt,
    );
  }

  private toUser(r: PrismaUser): UserModel {
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
