import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { Role } from '../../../shared/common/enums/role.enum';
import { ListCommunicationsQueryDto } from '../dtos/communication.dtos';
import { CommunicationModel } from '../models/communication.model';
import { GetCommunicationUseCase } from '../use-cases/get-communication.use-case';
import { ListCommunicationsUseCase } from '../use-cases/list-communications.use-case';

const toResponse = (c: CommunicationModel) => ({
  id: c.id,
  title: c.title,
  body: c.body,
  type: c.type,
  channel: c.channel,
  status: c.status,
  audience: c.audience,
  recipientCount: c.recipientCount,
  deliveredCount: c.deliveredCount,
  failedCount: c.failedCount,
  sentById: c.sentById,
  sentByName: c.sentByName,
  scheduledAt: c.scheduledAt?.toISOString() ?? null,
  sentAt: c.sentAt?.toISOString() ?? null,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

/**
 * Communication history / audit log — the admin-facing "communication center".
 * Read-only for now: it records what was sent, to whom, when and how. Composing
 * and dispatching live communications is a separate, future concern.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('communications')
export class CommunicationsController {
  constructor(
    private readonly listUC: ListCommunicationsUseCase,
    private readonly getUC: GetCommunicationUseCase,
  ) {}

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get()
  async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListCommunicationsQueryDto,
  ) {
    const limit = query.limit ?? 25;
    const offset = query.offset ?? 0;
    const { data, total } = await this.listUC.execute({
      tenantId: actor.tenantId,
      q: query.q,
      type: query.type,
      channel: query.channel,
      status: query.status,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      limit,
      offset,
    });
    return { data: data.map(toResponse), meta: { total, limit, offset } };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get(':id')
  async get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const c = await this.getUC.execute({ tenantId: actor.tenantId, id });
    return { data: toResponse(c) };
  }
}
