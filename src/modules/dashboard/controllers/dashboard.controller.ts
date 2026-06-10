import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Delete,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { PaginationQueryDto } from '../../../shared/common/dtos/pagination-query.dto';
import { Role } from '../../../shared/common/enums/role.enum';
import { ListNotificationsForUserUseCase } from '../../notifications/use-cases/list-notifications.use-case';
import { MarkNotificationReadUseCase } from '../../notifications/use-cases/mark-notification-read.use-case';
import { DeleteNotificationUseCase } from '../../notifications/use-cases/delete-notification.use-case';
import { GetDashboardSummaryUseCase } from '../use-cases/get-dashboard-summary.use-case';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly summaryUC: GetDashboardSummaryUseCase) {}

  /** Single batched payload powering the ERP module-card grid + the two operational panels. */
  @Roles(Role.TEACHER, Role.SUPER_ADMIN, Role.STUDENT)
  @Get('summary')
  async summary(@CurrentUser() actor: AuthenticatedUser, @Query('branchId') branchId?: string) {
    // Teachers are always pinned to their own branch; only SUPER_ADMIN may pick
    // a branch (or omit it for tenant-wide "All branches").
    const effectiveBranchId =
      actor.role === Role.TEACHER
        ? (actor.branchId ?? undefined)
        : branchId && branchId.length > 0
          ? branchId
          : undefined;
    const r = await this.summaryUC.execute({
      tenantId: actor.tenantId,
      actorUserId: actor.sub,
      actorRole: actor.role,
      branchId: effectiveBranchId,
    });
    return { data: r };
  }
}

/**
 * Notifications endpoints live under /dashboard/teacher for backwards
 * compatibility with the existing frontend client. Consider moving to
 * /notifications in a later cleanup.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('dashboard/teacher')
export class DashboardNotificationsController {
  constructor(
    private readonly listNotificationsUC: ListNotificationsForUserUseCase,
    private readonly markReadUC: MarkNotificationReadUseCase,
    private readonly deleteUC: DeleteNotificationUseCase,
  ) {}

  @Roles(Role.TEACHER, Role.STUDENT, Role.SUPER_ADMIN)
  @Get('notifications')
  async notifications(@CurrentUser() actor: AuthenticatedUser, @Query() query: PaginationQueryDto) {
    const r = await this.listNotificationsUC.execute({
      tenantId: actor.tenantId,
      userId: actor.sub,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
    return {
      data: r.data.map((n) => ({
        id: n.id,
        channel: n.channel,
        subject: n.subject,
        body: n.body,
        readAt: n.readAt?.toISOString() ?? null,
        sentAt: n.sentAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
      meta: r.meta,
    };
  }

  @Roles(Role.TEACHER, Role.STUDENT, Role.SUPER_ADMIN)
  @Post('notifications/:id/read')
  @HttpCode(HttpStatus.OK)
  async markRead(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const n = await this.markReadUC.execute({
      tenantId: actor.tenantId,
      userId: actor.sub,
      id,
    });
    return {
      data: {
        id: n.id,
        readAt: n.readAt?.toISOString() ?? null,
      },
    };
  }

  @Roles(Role.TEACHER, Role.STUDENT, Role.SUPER_ADMIN)
  @Delete('notifications')
  @HttpCode(HttpStatus.OK)
  async clearAll(@CurrentUser() actor: AuthenticatedUser) {
    await this.deleteUC.executeBulk({
      tenantId: actor.tenantId,
      userId: actor.sub,
    });
    return { data: { success: true } };
  }

  @Roles(Role.TEACHER, Role.STUDENT, Role.SUPER_ADMIN)
  @Delete('notifications/:id')
  @HttpCode(HttpStatus.OK)
  async clearOne(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    await this.deleteUC.execute({
      tenantId: actor.tenantId,
      userId: actor.sub,
      id,
    });
    return { data: { success: true } };
  }
}
