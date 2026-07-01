import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { ReportFilterDto } from '../dtos/report-filter.dto';
import { ExamHeatmapQueryDto, ExamStudentsQueryDto } from '../dtos/exam-analytics-query.dto';
import { ReportFilters } from '../repositories/reports.repository';
import { ExamAnalyticsUseCases } from '../use-cases/exam-analytics.use-cases';
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
    private readonly examAnalyticsUC: ExamAnalyticsUseCases,
  ) {}

  @Get('overview')
  async overview(@CurrentUser() actor: AuthenticatedUser, @Query() query: ReportFilterDto) {
    const filters = this.branchScope(actor, toFilters(query));
    return {
      data: await this.overviewUC.execute({
        tenantId: actor.tenantId,
        createdBy: this.teacherScope(actor),
        branchId: filters.branchId,
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

  /* ── Deep exam-specific analytics (the /reports/exams/:id dashboard) ── */

  @Get('exams/:examId/analytics')
  async examAnalytics(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('examId', new ParseUUIDPipe()) examId: string,
  ) {
    return { data: await this.examAnalyticsUC.analytics(actor, examId) };
  }

  @Get('exams/:examId/students')
  async examStudents(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('examId', new ParseUUIDPipe()) examId: string,
    @Query() query: ExamStudentsQueryDto,
  ) {
    const page = await this.examAnalyticsUC.students(actor, examId, {
      q: query.q,
      status: query.status,
      sort: query.sort,
      dir: query.dir,
      limit: query.limit ?? 25,
      offset: query.offset ?? 0,
      discipline: query.discipline,
      batch: query.batch,
      section: query.section,
    });
    return {
      data: page.data,
      meta: { total: page.total, limit: query.limit ?? 25, offset: query.offset ?? 0, attended: page.attended, filters: page.filters },
    };
  }

  @Get('exams/:examId/students/:studentId/breakdown')
  async examStudentBreakdown(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('examId', new ParseUUIDPipe()) examId: string,
    @Param('studentId', new ParseUUIDPipe()) studentId: string,
  ) {
    return { data: await this.examAnalyticsUC.breakdown(actor, examId, studentId) };
  }

  @Get('exams/:examId/heatmap')
  async examHeatmap(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('examId', new ParseUUIDPipe()) examId: string,
    @Query() query: ExamHeatmapQueryDto,
  ) {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const map = await this.examAnalyticsUC.heatmap(actor, examId, limit, offset);
    return { data: map, meta: { total: map.total, limit, offset } };
  }

  @Get('students')
  async students(@CurrentUser() actor: AuthenticatedUser, @Query() query: ReportFilterDto) {
    const filters = this.branchScope(actor, toFilters(query));
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
    const filters = this.branchScope(actor, toFilters(query));
    const { rows, total } = await this.topicReportsUC.execute({
      tenantId: actor.tenantId,
      filters,
    });
    return { data: rows, meta: meta(total, filters) };
  }

  @Get('weak-topics')
  async weakTopics(@CurrentUser() actor: AuthenticatedUser, @Query() query: ReportFilterDto) {
    const filters = this.branchScope(actor, toFilters(query));
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
    const filters = this.branchScope(actor, toFilters(query));
    const { rows, total } = await this.classReportsUC.execute({
      tenantId: actor.tenantId,
      filters,
    });
    return { data: rows, meta: meta(total, filters) };
  }

  private teacherScope(actor: AuthenticatedUser): string | undefined {
    return actor.role === Role.TEACHER ? actor.sub : undefined;
  }

  /** Tenant-wide reports (students / topics / classes / weak-topics) are branch-scoped
   *  for a TEACHER — locked to their own branch so they never see other branches. A
   *  SUPER_ADMIN keeps the optional `branchId` filter from the query. */
  private branchScope(actor: AuthenticatedUser, filters: ReportFilters): ReportFilters {
    return actor.role === Role.TEACHER
      ? { ...filters, branchId: actor.branchId ?? undefined }
      : filters;
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
    discipline: q.discipline,
    batch: q.batch,
    section: q.section,
    subject: q.subject,
    unallocated: q.unallocated,
    limit: q.limit ?? 50,
    offset: q.offset ?? 0,
  };
}

function meta(total: number, f: ReportFilters) {
  return { total, limit: f.limit, offset: f.offset };
}
