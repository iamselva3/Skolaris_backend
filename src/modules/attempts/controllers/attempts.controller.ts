import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { IsBooleanString, IsDateString, IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { PaginationQueryDto } from '../../../shared/common/dtos/pagination-query.dto';
import { Role } from '../../../shared/common/enums/role.enum';
import { PrismaService } from '../../../shared/database/prisma.service';
import type { AttemptStatus } from '../models/exam-attempt.model';

const STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'GRADED', 'FLAGGED'] as const;

class ListAttemptsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() examId?: string;
  @IsOptional() @IsUUID() studentId?: string;
  @IsOptional() @IsEnum(STATUSES) status?: AttemptStatus;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsBooleanString() hasViolations?: string;
  @IsOptional() @IsString() @MaxLength(80) q?: string;
}

/**
 * Cross-exam attempts browser for admins and graders.
 * Returns a denormalized row joining attempt + exam.title + student.name.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('attempts')
export class AttemptsController {
  constructor(private readonly prisma: PrismaService) {}

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get()
  async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListAttemptsQueryDto,
  ) {
    const where: import('@prisma/client').Prisma.ExamAttemptWhereInput = {
      tenantId: actor.tenantId,
    };
    if (query.examId) where.examId = query.examId;
    if (query.studentId) where.studentId = query.studentId;
    if (query.status) where.status = query.status;
    if (query.hasViolations === 'true') where.violationCount = { gt: 0 };
    if (query.from || query.to) {
      where.submittedAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.examAttempt.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: [{ submittedAt: 'desc' }, { createdAt: 'desc' }],
        include: {
          exam: { select: { id: true, title: true } },
          student: { include: { user: { select: { name: true, email: true } } } },
        },
      }),
      this.prisma.examAttempt.count({ where }),
    ]);
    return {
      data: rows.map((r) => ({
        id: r.id,
        examId: r.examId,
        examTitle: r.exam.title,
        studentId: r.studentId,
        studentName: r.student.user.name,
        studentEmail: r.student.user.email,
        status: r.status,
        score: r.score ? Number(r.score) : null,
        autoSubmitted: r.autoSubmitted,
        violationCount: r.violationCount,
        startedAt: r.startedAt?.toISOString() ?? null,
        submittedAt: r.submittedAt?.toISOString() ?? null,
        gradedAt: r.gradedAt?.toISOString() ?? null,
      })),
      meta: { total, limit, offset },
    };
  }
}
