import {
  Body,
  Controller,
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
import { CreateSubjectDto, ListSubjectsQueryDto, UpdateSubjectDto } from '../dtos/taxonomy.dtos';
import { SubjectModel } from '../models/taxonomy.models';
import {
  CreateSubjectUseCase,
  GetSubjectUseCase,
  ListMySubjectsUseCase,
  ListSubjectsUseCase,
  UpdateSubjectUseCase,
} from '../use-cases/subjects.use-cases';

const toResponse = (s: SubjectModel) => ({
  id: s.id,
  programId: s.programId,
  program: s.program ?? undefined,
  name: s.name,
  isActive: s.isActive,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
});

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('subjects')
export class SubjectsController {
  constructor(
    private readonly listUC: ListSubjectsUseCase,
    private readonly getUC: GetSubjectUseCase,
    private readonly createUC: CreateSubjectUseCase,
    private readonly updateUC: UpdateSubjectUseCase,
  ) {}

  @Roles(Role.SUPER_ADMIN, Role.TEACHER, Role.STUDENT)
  @Get()
  async list(@CurrentUser() actor: AuthenticatedUser, @Query() query: ListSubjectsQueryDto) {
    const isActive = query.isActive === undefined ? undefined : query.isActive === '1';
    const rows = await this.listUC.execute({
      tenantId: actor.tenantId,
      programId: query.programId,
      isActive,
    });
    return { data: rows.map(toResponse) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER, Role.STUDENT)
  @Get(':id')
  async get(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    const s = await this.getUC.execute({ tenantId: actor.tenantId, id });
    return { data: toResponse(s) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateSubjectDto) {
    const s = await this.createUC.execute({
      actor,
      tenantId: actor.tenantId,
      programId: dto.programId,
      name: dto.name,
    });
    return { data: toResponse(s) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Patch(':id')
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSubjectDto,
  ) {
    const s = await this.updateUC.execute({ tenantId: actor.tenantId, id, ...dto });
    return { data: toResponse(s) };
  }
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.TEACHER, Role.SUPER_ADMIN)
@Controller('me/subjects')
export class MySubjectsController {
  constructor(private readonly listMine: ListMySubjectsUseCase) {}

  @Get()
  async list(@CurrentUser() actor: AuthenticatedUser) {
    const rows = await this.listMine.execute({ tenantId: actor.tenantId, userId: actor.sub });
    return { data: rows.map(toResponse) };
  }
}
