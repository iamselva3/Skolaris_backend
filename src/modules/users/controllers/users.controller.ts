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
import { PaginatedResponse } from '../../../shared/common/dtos/paginated-response.dto';
import { Role } from '../../../shared/common/enums/role.enum';
import { CreateUserDto } from '../dtos/create-user.dto';
import { ListUsersQueryDto } from '../dtos/list-users-query.dto';
import { UpdateUserDto } from '../dtos/update-user.dto';
import { UserResponse, toUserResponse } from '../dtos/user-response.dto';
import { CreateUserUseCase } from '../use-cases/create-user.use-case';
import { DisableUserUseCase } from '../use-cases/disable-user.use-case';
import { GetUserUseCase } from '../use-cases/get-user.use-case';
import { ListUsersUseCase } from '../use-cases/list-users.use-case';
import { UpdateUserUseCase } from '../use-cases/update-user.use-case';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(
    private readonly createUserUseCase: CreateUserUseCase,
    private readonly listUsersUseCase: ListUsersUseCase,
    private readonly getUserUseCase: GetUserUseCase,
    private readonly updateUserUseCase: UpdateUserUseCase,
    private readonly disableUserUseCase: DisableUserUseCase,
  ) {}

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateUserDto,
  ): Promise<{ data: UserResponse }> {
    const user = await this.createUserUseCase.execute({
      actor,
      email: dto.email,
      name: dto.name,
      password: dto.password,
      role: dto.role,
      branchId: dto.branchId,
    });
    return { data: toUserResponse(user) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get()
  async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListUsersQueryDto,
  ): Promise<PaginatedResponse<UserResponse>> {
    const result = await this.listUsersUseCase.execute({
      tenantId: actor.tenantId,
      role: query.role,
      branchId: query.branchId,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
    return { data: result.data.map(toUserResponse), meta: result.meta };
  }

  // Note: no @Roles → JwtAuthGuard alone protects this. Self-access check lives in the use case.
  @Get(':id')
  async get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ data: UserResponse }> {
    const user = await this.getUserUseCase.execute({ actor, id });
    return { data: toUserResponse(user) };
  }

  @Patch(':id')
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<{ data: UserResponse }> {
    const user = await this.updateUserUseCase.execute({
      actor,
      id,
      name: dto.name,
      password: dto.password,
      branchId: dto.branchId,
      status: dto.status,
    });
    return { data: toUserResponse(user) };
  }

  @Roles(Role.SUPER_ADMIN)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.disableUserUseCase.execute({ tenantId: actor.tenantId, id });
  }
}
