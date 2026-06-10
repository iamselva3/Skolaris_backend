import { Injectable } from '@nestjs/common';
import {
  Prisma,
  Violation as PrismaViolation,
  ViolationType as PrismaViolationType,
} from '@prisma/client';
import { PrismaService } from '../../../shared/database/prisma.service';
import { ViolationModel, ViolationType } from '../models/violation.model';
import { CreateViolationInput, IViolationRepository } from './violation.repository';

@Injectable()
export class PrismaViolationRepository implements IViolationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async bulkCreate(input: CreateViolationInput[]): Promise<number> {
    if (input.length === 0) return 0;
    const r = await this.prisma.violation.createMany({
      data: input.map((v) => ({
        tenantId: v.tenantId,
        attemptId: v.attemptId,
        type: v.type as PrismaViolationType,
        detail:
          v.detail === null || v.detail === undefined
            ? Prisma.JsonNull
            : (v.detail as Prisma.InputJsonValue),
        clientTimestamp: v.clientTimestamp,
      })),
    });
    return r.count;
  }

  async countByAttempt(tenantId: string, attemptId: string): Promise<number> {
    return this.prisma.violation.count({ where: { tenantId, attemptId } });
  }

  async countByAttemptAndType(
    tenantId: string,
    attemptId: string,
    type: ViolationType,
  ): Promise<number> {
    return this.prisma.violation.count({
      where: { tenantId, attemptId, type: type as PrismaViolationType },
    });
  }

  async listByAttempt(tenantId: string, attemptId: string): Promise<ViolationModel[]> {
    const rows = await this.prisma.violation.findMany({
      where: { tenantId, attemptId },
      orderBy: { serverTimestamp: 'asc' },
    });
    return rows.map((r) => this.toModel(r));
  }

  private toModel(r: PrismaViolation): ViolationModel {
    return new ViolationModel(
      r.id,
      r.tenantId,
      r.attemptId,
      r.type as ViolationType,
      (r.detail as Record<string, unknown> | null) ?? null,
      r.clientTimestamp,
      r.serverTimestamp,
    );
  }
}
