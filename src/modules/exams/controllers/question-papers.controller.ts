import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { CreateQuestionPaperDto, ListQuestionPapersQueryDto } from '../dtos/question-paper.dtos';
import {
  QuestionPaperResponse,
  QuestionPapersSummary,
  toQuestionPaperResponse,
} from '../dtos/question-paper-responses';
import { ExamResponse, toExamResponse } from '../dtos/exam-responses';
import { CloneQuestionPaperUseCase } from '../use-cases/clone-question-paper.use-case';
import { CreateQuestionPaperUseCase } from '../use-cases/create-question-paper.use-case';
import { CreateTestFromPaperUseCase } from '../use-cases/create-test-from-paper.use-case';
import { GetQuestionPapersSummaryUseCase } from '../use-cases/get-question-papers-summary.use-case';
import { ListQuestionPapersUseCase } from '../use-cases/list-question-papers.use-case';

/**
 * Manage Question Papers — focused operational view over the Exam entity (no
 * duplicate data model). compositionStatus is DERIVED in the response.
 * Reuses the same JwtAuthGuard + RolesGuard + teacher-scoping pattern as the
 * Exams controller.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('question-papers')
export class QuestionPapersController {
  constructor(
    private readonly listUC: ListQuestionPapersUseCase,
    private readonly summaryUC: GetQuestionPapersSummaryUseCase,
    private readonly cloneUC: CloneQuestionPaperUseCase,
    private readonly createUC: CreateQuestionPaperUseCase,
    private readonly createTestFromPaperUC: CreateTestFromPaperUseCase,
  ) {}

  /** Teacher → own papers only; Super-admin → tenant-wide (may filter by createdBy). */
  private teacherScope(actor: AuthenticatedUser, explicitCreatedBy?: string): string | undefined {
    if (actor.role === Role.TEACHER) return actor.sub;
    return explicitCreatedBy;
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get()
  async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListQuestionPapersQueryDto,
  ): Promise<PaginatedResponse<QuestionPaperResponse>> {
    const r = await this.listUC.execute({
      tenantId: actor.tenantId,
      compositionStatus: query.compositionStatus,
      createdBy: this.teacherScope(actor, query.createdBy),
      programId: query.programId,
      subjectId: query.subjectId,
      classroomId: query.classroomId,
      section: query.section,
      q: query.q,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
    return { data: r.data.map(toQuestionPaperResponse), meta: r.meta };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get('summary')
  async summary(@CurrentUser() actor: AuthenticatedUser): Promise<{ data: QuestionPapersSummary }> {
    const data = await this.summaryUC.execute({
      tenantId: actor.tenantId,
      createdBy: this.teacherScope(actor),
    });
    return { data };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateQuestionPaperDto,
  ): Promise<{ data: ExamResponse }> {
    const paper = await this.createUC.execute({
      actor,
      title: dto.title,
      description: dto.description,
      durationSeconds: dto.durationSeconds,
      defaultNegativeMarks: dto.defaultNegativeMarks,
      randomizeQuestions: dto.randomizeQuestions,
      randomizeOptions: dto.randomizeOptions,
      programId: dto.programId,
      subjectId: dto.subjectId,
      antiCheatConfig: dto.antiCheatConfig,
    });
    return { data: toExamResponse(paper) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post(':id/clone')
  @HttpCode(HttpStatus.CREATED)
  async clone(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ data: ExamResponse }> {
    const cloned = await this.cloneUC.execute({ actor, sourceId: id });
    return { data: toExamResponse(cloned) };
  }

  /**
   * Promotes a Question Paper to a fresh DRAFT Test. The caller then schedules
   * + assigns + publishes the returned test via the existing /exams endpoints.
   */
  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post(':id/create-test')
  @HttpCode(HttpStatus.CREATED)
  async createTestFromPaper(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ data: ExamResponse }> {
    const test = await this.createTestFromPaperUC.execute({ actor, paperId: id });
    return { data: toExamResponse(test) };
  }
}
