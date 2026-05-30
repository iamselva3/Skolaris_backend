import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { Role } from '../../../shared/common/enums/role.enum';
import { StudentResolverService } from '../../attempts/services/student-resolver.service';
import { GetWeakTopicsForStudentUseCase } from '../use-cases/report-query.use-cases';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.STUDENT)
@Controller('me/reports')
export class MeReportsController {
  constructor(
    private readonly resolver: StudentResolverService,
    private readonly weakTopicsUC: GetWeakTopicsForStudentUseCase,
  ) {}

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
        recommendation: `Focus on ${r.topic} — current score ${Math.round(Number(r.scorePercent))}%`,
      })),
    };
  }
}
