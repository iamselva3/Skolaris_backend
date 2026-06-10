import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { ReportFilterDto } from '../dtos/report-filter.dto';
import { ReportFilters } from '../repositories/reports.repository';
import {
  GetClassReportsUseCase,
  GetExamReportDetailUseCase,
  GetExamReportsUseCase,
  GetQuestionReportsUseCase,
  GetReportsOverviewUseCase,
  GetStudentReportDetailUseCase,
  GetStudentReportsUseCase,
  GetTopicReportsUseCase,
  GetWeakTopicReportUseCase,
} from '../use-cases/report.use-cases';

/**
 * Operational reporting workspace. All rows are tenant-scoped via the JWT.
 * Row scoping: a TEACHER sees exam/question reports limited to content they
 * authored (`createdBy`); student/topic/class/weak-topic data is tenant-wide.
 * A SUPER_ADMIN sees everything and may narrow by `branchId` and other filters.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN, Role.TEACHER)
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly overviewUC: GetReportsOverviewUseCase,
    private readonly examReportsUC: GetExamReportsUseCase,
    private readonly examReportDetailUC: GetExamReportDetailUseCase,
    private readonly studentReportsUC: GetStudentReportsUseCase,
    private readonly studentReportDetailUC: GetStudentReportDetailUseCase,
    private readonly topicReportsUC: GetTopicReportsUseCase,
    private readonly weakTopicReportUC: GetWeakTopicReportUseCase,
    private readonly questionReportsUC: GetQuestionReportsUseCase,
    private readonly classReportsUC: GetClassReportsUseCase,
  ) {}

  @Get('overview')
  async overview(@CurrentUser() actor: AuthenticatedUser) {
    return {
      data: await this.overviewUC.execute({
        tenantId: actor.tenantId,
        createdBy: this.teacherScope(actor),
      }),
    };
  }

  @Get('exams')
  async exams(@CurrentUser() actor: AuthenticatedUser, @Query() query: ReportFilterDto) {
    const filters = toFilters(query);
    const { rows, total } = await this.examReportsUC.execute({
      tenantId: actor.tenantId,
      createdBy: this.teacherScope(actor),
      filters,
    });
    return { data: rows, meta: meta(total, filters) };
  }

  @Get('exams/:examId')
  async examDetail(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('examId', new ParseUUIDPipe()) examId: string,
  ) {
    return { data: await this.examReportDetailUC.execute({ tenantId: actor.tenantId, examId }) };
  }

  @Get('students')
  async students(@CurrentUser() actor: AuthenticatedUser, @Query() query: ReportFilterDto) {
    const filters = toFilters(query);
    const { rows, total } = await this.studentReportsUC.execute({
      tenantId: actor.tenantId,
      filters,
    });
    return { data: rows, meta: meta(total, filters) };
  }

  @Get('students/:studentId')
  async studentDetail(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('studentId', new ParseUUIDPipe()) studentId: string,
  ) {
    return {
      data: await this.studentReportDetailUC.execute({ tenantId: actor.tenantId, studentId }),
    };
  }

  @Get('topics')
  async topics(@CurrentUser() actor: AuthenticatedUser, @Query() query: ReportFilterDto) {
    const filters = toFilters(query);
    const { rows, total } = await this.topicReportsUC.execute({
      tenantId: actor.tenantId,
      filters,
    });
    return { data: rows, meta: meta(total, filters) };
  }

  @Get('weak-topics')
  async weakTopics(@CurrentUser() actor: AuthenticatedUser, @Query() query: ReportFilterDto) {
    const filters = toFilters(query);
    const { rows, total } = await this.weakTopicReportUC.execute({
      tenantId: actor.tenantId,
      filters,
    });
    return { data: rows, meta: meta(total, filters) };
  }

  @Get('questions')
  async questions(@CurrentUser() actor: AuthenticatedUser, @Query() query: ReportFilterDto) {
    const filters = toFilters(query);
    const { rows, total } = await this.questionReportsUC.execute({
      tenantId: actor.tenantId,
      createdBy: this.teacherScope(actor),
      filters,
    });
    return { data: rows, meta: meta(total, filters) };
  }

  @Get('classes')
  async classes(@CurrentUser() actor: AuthenticatedUser, @Query() query: ReportFilterDto) {
    const filters = toFilters(query);
    const { rows, total } = await this.classReportsUC.execute({
      tenantId: actor.tenantId,
      filters,
    });
    return { data: rows, meta: meta(total, filters) };
  }

  private teacherScope(actor: AuthenticatedUser): string | undefined {
    return actor.role === Role.TEACHER ? actor.sub : undefined;
  }
}

function toFilters(q: ReportFilterDto): ReportFilters {
  return {
    dateFrom: q.dateFrom,
    dateTo: q.dateTo,
    programId: q.programId,
    subjectId: q.subjectId,
    topicId: q.topicId,
    chapterId: q.chapterId,
    branchId: q.branchId,
    classroomId: q.classroomId,
    q: q.q,
    limit: q.limit ?? 50,
    offset: q.offset ?? 0,
  };
}

function meta(total: number, f: ReportFilters) {
  return { total, limit: f.limit, offset: f.offset };
}
