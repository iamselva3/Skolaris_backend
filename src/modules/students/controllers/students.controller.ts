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
import { CreateStudentDto } from '../dtos/create-student.dto';
import { ListStudentsQueryDto } from '../dtos/list-students-query.dto';
import { StudentResponse, toStudentResponse } from '../dtos/student-response.dto';
import { UpdateStudentDto } from '../dtos/update-student.dto';
import { CreateStudentUseCase } from '../use-cases/create-student.use-case';
import { DisableStudentUseCase } from '../use-cases/disable-student.use-case';
import { GetStudentUseCase } from '../use-cases/get-student.use-case';
import { ListStudentsUseCase } from '../use-cases/list-students.use-case';
import { UpdateStudentUseCase } from '../use-cases/update-student.use-case';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('students')
export class StudentsController {
  constructor(
    private readonly createStudentUseCase: CreateStudentUseCase,
    private readonly listStudentsUseCase: ListStudentsUseCase,
    private readonly getStudentUseCase: GetStudentUseCase,
    private readonly updateStudentUseCase: UpdateStudentUseCase,
    private readonly disableStudentUseCase: DisableStudentUseCase,
  ) {}

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateStudentDto,
  ): Promise<{ data: StudentResponse }> {
    const created = await this.createStudentUseCase.execute({
      actor,
      email: dto.email,
      name: dto.name,
      password: dto.password,
      branchId: dto.branchId,
      classLabel: dto.classLabel,
      rollNo: dto.rollNo,
      parentContact: dto.parentContact,
    });
    return { data: toStudentResponse(created) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get()
  async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListStudentsQueryDto,
  ): Promise<PaginatedResponse<StudentResponse>> {
    const r = await this.listStudentsUseCase.execute({
      tenantId: actor.tenantId,
      branchId: query.branchId,
      batch: query.batch,
      section: query.section,
      subject: query.subject,
      unallocated: query.unallocated,
      q: query.q,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
    return { data: r.data.map(toStudentResponse), meta: r.meta };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get(':id')
  async get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ data: StudentResponse }> {
    const r = await this.getStudentUseCase.execute({ tenantId: actor.tenantId, id });
    return { data: toStudentResponse(r) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Patch(':id')
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateStudentDto,
  ): Promise<{ data: StudentResponse }> {
    const r = await this.updateStudentUseCase.execute({
      actor,
      id,
      classLabel: dto.classLabel,
      rollNo: dto.rollNo,
      parentContact: dto.parentContact,
      branchId: dto.branchId,
    });
    return { data: toStudentResponse(r) };
  }

  @Roles(Role.SUPER_ADMIN)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.disableStudentUseCase.execute({ tenantId: actor.tenantId, id });
  }
}
