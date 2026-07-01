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
import { PaginationQueryDto } from '../../../shared/common/dtos/pagination-query.dto';
import { Role } from '../../../shared/common/enums/role.enum';
import { CreateTenantDto } from '../dtos/create-tenant.dto';
import { UpdateTenantDto } from '../dtos/update-tenant.dto';
import { CreateTenantUseCase } from '../use-cases/create-tenant.use-case';
import { GetTenantUseCase } from '../use-cases/get-tenant.use-case';
import { ListTenantsUseCase } from '../use-cases/list-tenants.use-case';
import { UpdateTenantUseCase } from '../use-cases/update-tenant.use-case';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('tenants')
export class TenantsController {
  constructor(
    private readonly createTenantUseCase: CreateTenantUseCase,
    private readonly listTenantsUseCase: ListTenantsUseCase,
    private readonly getTenantUseCase: GetTenantUseCase,
    private readonly updateTenantUseCase: UpdateTenantUseCase,
  ) {}

  @Roles(Role.SUPER_ADMIN)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateTenantDto) {
    const result = await this.createTenantUseCase.execute({
      name: dto.name,
      slug: dto.slug,
      admin: {
        email: dto.admin.email,
        name: dto.admin.name,
        password: dto.admin.password,
      },
    });
    return { data: result };
  }

  @Roles(Role.SUPER_ADMIN)
  @Get()
  async list(@Query() query: PaginationQueryDto) {
    return this.listTenantsUseCase.execute({
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
  }

  /**
   * Current tenant's exam-attempt settings (the violation limit super-admins
   * configure from the Test Management workspace). Keyed off the JWT tenant, so
   * a super-admin never needs to know their tenant id. Declared BEFORE the
   * `:id` routes so `me` is not parsed as a UUID.
   */
  @Roles(Role.SUPER_ADMIN)
  @Get('me/settings')
  async getMySettings(@CurrentUser() actor: AuthenticatedUser) {
    const tenant = await this.getTenantUseCase.execute(actor.tenantId);
    return { data: { examViolationLimit: tenant.examViolationLimit } };
  }

  @Roles(Role.SUPER_ADMIN)
  @Patch('me/settings')
  async updateMySettings(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: UpdateTenantDto,
  ) {
    const tenant = await this.updateTenantUseCase.execute({
      id: actor.tenantId,
      examViolationLimit: dto.examViolationLimit,
    });
    return { data: { examViolationLimit: tenant.examViolationLimit } };
  }

  @Roles(Role.SUPER_ADMIN)
  @Get(':id')
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    const tenant = await this.getTenantUseCase.execute(id);
    return { data: tenant };
  }

  @Roles(Role.SUPER_ADMIN)
  @Patch(':id')
  async update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateTenantDto) {
    const tenant = await this.updateTenantUseCase.execute({
      id,
      name: dto.name,
      status: dto.status,
    });
    return { data: tenant };
  }
}
