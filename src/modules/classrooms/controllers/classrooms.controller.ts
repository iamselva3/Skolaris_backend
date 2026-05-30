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
import { PaginatedResponse } from '../../../shared/common/dtos/paginated-response.dto';
import {
  StudentResponse,
  toStudentResponse,
} from '../../students/dtos/student-response.dto';
import { AddStudentsDto } from '../dtos/add-students.dto';
import {
  ClassroomResponse,
  toClassroomResponse,
  toClassroomResponseFromWithCount,
} from '../dtos/classroom-response.dto';
import { CreateClassroomDto } from '../dtos/create-classroom.dto';
import { ListClassroomsQueryDto } from '../dtos/list-classrooms-query.dto';
import { UpdateClassroomDto } from '../dtos/update-classroom.dto';
import { AddStudentsToClassroomUseCase } from '../use-cases/add-students-to-classroom.use-case';
import { CreateClassroomUseCase } from '../use-cases/create-classroom.use-case';
import { DeleteClassroomUseCase } from '../use-cases/delete-classroom.use-case';
import { GetClassroomUseCase } from '../use-cases/get-classroom.use-case';
import { ListClassroomStudentsUseCase } from '../use-cases/list-classroom-students.use-case';
import { ListClassroomsUseCase } from '../use-cases/list-classrooms.use-case';
import { RemoveStudentFromClassroomUseCase } from '../use-cases/remove-student-from-classroom.use-case';
import { UpdateClassroomUseCase } from '../use-cases/update-classroom.use-case';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('classrooms')
export class ClassroomsController {
  constructor(
    private readonly createClassroomUseCase: CreateClassroomUseCase,
    private readonly listClassroomsUseCase: ListClassroomsUseCase,
    private readonly getClassroomUseCase: GetClassroomUseCase,
    private readonly updateClassroomUseCase: UpdateClassroomUseCase,
    private readonly deleteClassroomUseCase: DeleteClassroomUseCase,
    private readonly addStudentsUseCase: AddStudentsToClassroomUseCase,
    private readonly removeStudentUseCase: RemoveStudentFromClassroomUseCase,
    private readonly listClassroomStudentsUseCase: ListClassroomStudentsUseCase,
  ) {}

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateClassroomDto,
  ): Promise<{ data: ClassroomResponse }> {
    const c = await this.createClassroomUseCase.execute({
      actor,
      name: dto.name,
      branchId: dto.branchId,
      year: dto.year,
      section: dto.section,
      subject: dto.subject,
      teacherId: dto.teacherId,
    });
    return { data: toClassroomResponse(c, 0) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get()
  async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListClassroomsQueryDto,
  ): Promise<PaginatedResponse<ClassroomResponse>> {
    const r = await this.listClassroomsUseCase.execute({
      tenantId: actor.tenantId,
      branchId: query.branchId,
      createdBy: query.teacherId,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
    return { data: r.data.map(toClassroomResponseFromWithCount), meta: r.meta };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get(':id')
  async get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ data: ClassroomResponse }> {
    const c = await this.getClassroomUseCase.execute({ tenantId: actor.tenantId, id });
    return { data: toClassroomResponseFromWithCount(c) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Patch(':id')
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateClassroomDto,
  ): Promise<{ data: ClassroomResponse }> {
    const c = await this.updateClassroomUseCase.execute({
      actor,
      id,
      name: dto.name,
      year: dto.year,
      section: dto.section,
      subject: dto.subject,
    });
    return { data: toClassroomResponse(c) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.deleteClassroomUseCase.execute({ actor, id });
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post(':id/students')
  async addStudents(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AddStudentsDto,
  ): Promise<{ data: { added: string[]; alreadyMember: string[] } }> {
    const r = await this.addStudentsUseCase.execute({
      actor,
      classroomId: id,
      studentIds: dto.studentIds,
    });
    return { data: r };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Delete(':id/students/:studentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeStudent(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('studentId', new ParseUUIDPipe()) studentId: string,
  ): Promise<void> {
    await this.removeStudentUseCase.execute({ actor, classroomId: id, studentId });
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get(':id/students')
  async listStudents(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResponse<StudentResponse>> {
    const r = await this.listClassroomStudentsUseCase.execute({
      tenantId: actor.tenantId,
      classroomId: id,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
    return { data: r.data.map(toStudentResponse), meta: r.meta };
  }
}
