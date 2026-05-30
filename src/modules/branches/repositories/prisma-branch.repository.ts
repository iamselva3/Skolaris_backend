import { Injectable, NotFoundException } from '@nestjs/common';
import { Branch as PrismaBranch } from '@prisma/client';
import { PrismaService } from '../../../shared/database/prisma.service';
import { BranchModel } from '../models/branch.model';
import { IBranchRepository } from './branch.repository';

@Injectable()
export class PrismaBranchRepository implements IBranchRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, name: string): Promise<BranchModel> {
    const row = await this.prisma.branch.create({ data: { tenantId, name } });
    return this.toModel(row);
  }

  async findById(tenantId: string, id: string): Promise<BranchModel | null> {
    const row = await this.prisma.branch.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    return row ? this.toModel(row) : null;
  }

  async list(
    tenantId: string,
    limit: number,
    offset: number,
  ): Promise<{ data: BranchModel[]; total: number }> {
    const where = { tenantId, deletedAt: null };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.branch.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.branch.count({ where }),
    ]);
    return { data: rows.map((r) => this.toModel(r)), total };
  }

  async update(tenantId: string, id: string, name: string): Promise<BranchModel> {
    const updated = await this.prisma.branch.updateMany({
      where: { id, tenantId, deletedAt: null },
      data: { name },
    });
    if (updated.count === 0) {
      throw new NotFoundException('Branch not found');
    }
    const row = await this.prisma.branch.findUniqueOrThrow({ where: { id } });
    return this.toModel(row);
  }

  async softDelete(tenantId: string, id: string): Promise<void> {
    const result = await this.prisma.branch.updateMany({
      where: { id, tenantId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) {
      throw new NotFoundException('Branch not found');
    }
  }

  private toModel(r: PrismaBranch): BranchModel {
    return new BranchModel(r.id, r.tenantId, r.name, r.deletedAt, r.createdAt, r.updatedAt);
  }
}
