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
import { CreateChapterDto, ListChaptersQueryDto, UpdateChapterDto } from '../dtos/taxonomy.dtos';
import { ChapterModel } from '../models/taxonomy.models';
import {
  CreateChapterUseCase,
  DeleteChapterUseCase,
  GetChapterUseCase,
  ListChaptersUseCase,
  UpdateChapterUseCase,
} from '../use-cases/chapters.use-cases';

const toResponse = (c: ChapterModel) => ({
  id: c.id,
  subjectId: c.subjectId,
  name: c.name,
  position: c.position,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('chapters')
export class ChaptersController {
  constructor(
    private readonly listUC: ListChaptersUseCase,
    private readonly getUC: GetChapterUseCase,
    private readonly createUC: CreateChapterUseCase,
    private readonly updateUC: UpdateChapterUseCase,
    private readonly deleteUC: DeleteChapterUseCase,
  ) {}

  @Roles(Role.SUPER_ADMIN, Role.TEACHER, Role.STUDENT)
  @Get()
  async list(@CurrentUser() actor: AuthenticatedUser, @Query() query: ListChaptersQueryDto) {
    const rows = await this.listUC.execute({
      tenantId: actor.tenantId,
      subjectId: query.subjectId,
    });
    return { data: rows.map(toResponse) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER, Role.STUDENT)
  @Get(':id')
  async get(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    const c = await this.getUC.execute({ tenantId: actor.tenantId, id });
    return { data: toResponse(c) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateChapterDto) {
    const c = await this.createUC.execute({
      tenantId: actor.tenantId,
      userId: actor.sub,
      role: actor.role,
      subjectId: dto.subjectId,
      name: dto.name,
      position: dto.position,
    });
    return { data: toResponse(c) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Patch(':id')
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateChapterDto,
  ) {
    const c = await this.updateUC.execute({
      tenantId: actor.tenantId,
      userId: actor.sub,
      role: actor.role,
      id,
      ...dto,
    });
    return { data: toResponse(c) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.deleteUC.execute({ tenantId: actor.tenantId, id });
  }
}
