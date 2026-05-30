import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { Role } from '../../../shared/common/enums/role.enum';
import { StudentResolverService } from '../../attempts/services/student-resolver.service';
import { RecordViolationsDto } from '../dtos/violations.dtos';
import { RecordViolationsUseCase } from '../use-cases/record-violations.use-case';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.STUDENT)
@Controller('me/attempts')
export class MeViolationsController {
  constructor(
    private readonly resolver: StudentResolverService,
    private readonly recordUC: RecordViolationsUseCase,
  ) {}

  // Throttle: max 60 requests per 10s per IP/route. The DTO caps each request at 60 events,
  // so the worst case is 360 events/min/student — well within budget.
  @Throttle({ default: { limit: 60, ttl: 10_000 } })
  @Post(':attemptId/violations')
  @HttpCode(HttpStatus.OK)
  async record(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
    @Body() dto: RecordViolationsDto,
  ) {
    const studentId = await this.resolver.requireStudentIdForUser(actor.tenantId, actor.sub);
    const r = await this.recordUC.execute({
      tenantId: actor.tenantId,
      studentId,
      attemptId,
      events: dto.events.map((e) => ({
        type: e.type,
        clientTimestamp: new Date(e.clientTimestamp),
        detail: e.detail,
      })),
    });
    return { data: r };
  }
}
