import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { Role } from '../../../shared/common/enums/role.enum';
import { StudentResolverService } from '../../attempts/services/student-resolver.service';
import {
  GetStudentSummaryUseCase,
  GetSubjectPerformanceUseCase,
  GetWeakTopicsForStudentUseCase,
} from '../use-cases/report-query.use-cases';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.STUDENT)
@Controller('me/reports')
export class MeReportsController {
  constructor(
    private readonly resolver: StudentResolverService,
    private readonly weakTopicsUC: GetWeakTopicsForStudentUseCase,
    private readonly summaryUC: GetStudentSummaryUseCase,
    private readonly subjectsUC: GetSubjectPerformanceUseCase,
  ) {}

  // Overall performance snapshot for the signed-in student. Self-resolving so the
  // frontend never needs to know its own studentId.
  @Get('summary')
  async summary(@CurrentUser() actor: AuthenticatedUser) {
    const studentId = await this.resolver.requireStudentIdForUser(actor.tenantId, actor.sub);
    const s = await this.summaryUC.execute({ tenantId: actor.tenantId, studentId });
    return {
      data: {
        attemptsTotal: s.attemptsTotal,
        avgScore: s.avgScore,
        weakTopicsCount: s.weakTopicsCount,
      },
    };
  }

  // Subject-level rollup (all topics, weak and strong) — powers the subject
  // performance chart and strong-area insights.
  @Get('subjects')
  async subjects(@CurrentUser() actor: AuthenticatedUser) {
    const studentId = await this.resolver.requireStudentIdForUser(actor.tenantId, actor.sub);
    const rows = await this.subjectsUC.execute({ tenantId: actor.tenantId, studentId });
    return { data: rows };
  }

  @Get('weak-topics')
  async weakTopics(@CurrentUser() actor: AuthenticatedUser) {
    const studentId = await this.resolver.requireStudentIdForUser(actor.tenantId, actor.sub);
    const rows = await this.weakTopicsUC.execute({
      tenantId: actor.tenantId,
      studentId,
    });
    return {
      data: rows.map((r) => ({
        subject: r.subject,
        topic: r.topic,
        scorePercent: Number(r.scorePercent),
        attemptsCount: r.attemptsCount,
        correctCount: r.correctCount,
        recommendation: `Focus on ${r.topic} — current score ${Math.round(Number(r.scorePercent))}%`,
      })),
    };
  }
}
