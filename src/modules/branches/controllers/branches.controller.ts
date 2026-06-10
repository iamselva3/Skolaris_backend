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
import { PaginationQueryDto } from '../../../shared/common/dtos/pagination-query.dto';
import { Role } from '../../../shared/common/enums/role.enum';
import { CreateBranchDto } from '../dtos/create-branch.dto';
import { UpdateBranchDto } from '../dtos/update-branch.dto';
import { CreateBranchUseCase } from '../use-cases/create-branch.use-case';
import { DeleteBranchUseCase } from '../use-cases/delete-branch.use-case';
import { GetBranchUseCase } from '../use-cases/get-branch.use-case';
import { ListBranchesUseCase } from '../use-cases/list-branches.use-case';
import { UpdateBranchUseCase } from '../use-cases/update-branch.use-case';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('branches')
export class BranchesController {
  constructor(
    private readonly createBranchUseCase: CreateBranchUseCase,
    private readonly listBranchesUseCase: ListBranchesUseCase,
    private readonly getBranchUseCase: GetBranchUseCase,
    private readonly updateBranchUseCase: UpdateBranchUseCase,
    private readonly deleteBranchUseCase: DeleteBranchUseCase,
  ) {}

  @Roles(Role.SUPER_ADMIN)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateBranchDto) {
    const branch = await this.createBranchUseCase.execute({
      tenantId: user.tenantId,
      name: dto.name,
    });
    return { data: branch };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get()
  async list(@CurrentUser() user: AuthenticatedUser, @Query() query: PaginationQueryDto) {
    return this.listBranchesUseCase.execute({
      tenantId: user.tenantId,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get(':id')
  async get(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    const branch = await this.getBranchUseCase.execute({ tenantId: user.tenantId, id });
    return { data: branch };
  }

  @Roles(Role.SUPER_ADMIN)
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBranchDto,
  ) {
    const branch = await this.updateBranchUseCase.execute({
      tenantId: user.tenantId,
      id,
      name: dto.name,
    });
    return { data: branch };
  }

  @Roles(Role.SUPER_ADMIN)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.deleteBranchUseCase.execute({ tenantId: user.tenantId, id });
  }
}
