import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { Role } from '../../../shared/common/enums/role.enum';
import { CreateTopicDto, ListTopicsQueryDto, UpdateTopicDto } from '../dtos/taxonomy.dtos';
import { TopicModel } from '../models/taxonomy.models';
import {
  CreateTopicUseCase,
  DeleteTopicUseCase,
  GetTopicUseCase,
  ListTopicsUseCase,
  UpdateTopicUseCase,
} from '../use-cases/topics.use-cases';

const toResponse = (t: TopicModel) => ({
  id: t.id,
  chapterId: t.chapterId,
  name: t.name,
  position: t.position,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('topics')
export class TopicsController {
  constructor(
    private readonly listUC: ListTopicsUseCase,
    private readonly getUC: GetTopicUseCase,
    private readonly createUC: CreateTopicUseCase,
    private readonly updateUC: UpdateTopicUseCase,
    private readonly deleteUC: DeleteTopicUseCase,
  ) {}

  @Roles(Role.SUPER_ADMIN, Role.TEACHER, Role.STUDENT)
  @Get()
  async list(@CurrentUser() actor: AuthenticatedUser, @Query() query: ListTopicsQueryDto) {
    const rows = await this.listUC.execute({
      tenantId: actor.tenantId,
      chapterId: query.chapterId,
    });
    return { data: rows.map(toResponse) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER, Role.STUDENT)
  @Get(':id')
  async get(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    const t = await this.getUC.execute({ tenantId: actor.tenantId, id });
    return { data: toResponse(t) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateTopicDto) {
    const t = await this.createUC.execute({
      tenantId: actor.tenantId,
      userId: actor.sub,
      role: actor.role,
      chapterId: dto.chapterId,
      name: dto.name,
      position: dto.position,
    });
    return { data: toResponse(t) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Patch(':id')
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateTopicDto,
  ) {
    const t = await this.updateUC.execute({
      tenantId: actor.tenantId,
      userId: actor.sub,
      role: actor.role,
      id,
      ...dto,
    });
    return { data: toResponse(t) };
  }

  @Roles(Role.SUPER_ADMIN)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.deleteUC.execute({ tenantId: actor.tenantId, id });
  }
}
