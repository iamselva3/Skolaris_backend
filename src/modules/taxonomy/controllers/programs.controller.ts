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
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { Role } from '../../../shared/common/enums/role.enum';
import { CreateProgramDto, UpdateProgramDto } from '../dtos/taxonomy.dtos';
import { ProgramModel } from '../models/taxonomy.models';
import {
  CreateProgramUseCase,
  GetProgramUseCase,
  ListProgramsUseCase,
  UpdateProgramUseCase,
} from '../use-cases/programs.use-cases';

const toResponse = (p: ProgramModel) => ({
  id: p.id,
  code: p.code,
  name: p.name,
  isActive: p.isActive,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('programs')
export class ProgramsController {
  constructor(
    private readonly listUC: ListProgramsUseCase,
    private readonly getUC: GetProgramUseCase,
    private readonly createUC: CreateProgramUseCase,
    private readonly updateUC: UpdateProgramUseCase,
  ) {}

  @Roles(Role.SUPER_ADMIN, Role.TEACHER, Role.STUDENT)
  @Get()
  async list(@CurrentUser() actor: AuthenticatedUser) {
    const rows = await this.listUC.execute(actor.tenantId);
    return { data: rows.map(toResponse) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER, Role.STUDENT)
  @Get(':id')
  async get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const p = await this.getUC.execute({ tenantId: actor.tenantId, id });
    return { data: toResponse(p) };
  }

  @Roles(Role.SUPER_ADMIN)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateProgramDto) {
    const p = await this.createUC.execute({
      tenantId: actor.tenantId,
      code: dto.code,
      name: dto.name,
    });
    return { data: toResponse(p) };
  }

  @Roles(Role.SUPER_ADMIN)
  @Patch(':id')
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateProgramDto,
  ) {
    const p = await this.updateUC.execute({ tenantId: actor.tenantId, id, ...dto });
    return { data: toResponse(p) };
  }
}
