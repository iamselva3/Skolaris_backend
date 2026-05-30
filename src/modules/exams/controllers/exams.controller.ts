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
import {
  AddQuestionsToExamDto,
  AssignExamDto,
  CreateExamDto,
  CreateSectionDto,
  ListExamsQueryDto,
  UpdateExamDto,
  UpdateExamQuestionDto,
  UpdateSectionDto,
} from '../dtos/exam.dtos';
import {
  ExamResponse,
  ExamDetailResponse,
  toExamDetailResponse,
  toExamResponse,
} from '../dtos/exam-responses';
import { AddQuestionsToExamUseCase } from '../use-cases/add-questions-to-exam.use-case';
import { AssignExamUseCase } from '../use-cases/assign-exam.use-case';
import { CloseExamUseCase } from '../use-cases/close-exam.use-case';
import { CreateExamSectionUseCase } from '../use-cases/create-exam-section.use-case';
import { CreateExamUseCase } from '../use-cases/create-exam.use-case';
import { DeleteExamSectionUseCase } from '../use-cases/delete-exam-section.use-case';
import { DeleteExamUseCase } from '../use-cases/delete-exam.use-case';
import { GetExamAttemptDetailUseCase } from '../use-cases/get-exam-attempt-detail.use-case';
import { GetExamUseCase } from '../use-cases/get-exam.use-case';
import { ListExamAttemptsUseCase } from '../use-cases/list-exam-attempts.use-case';
import { ListExamsUseCase } from '../use-cases/list-exams.use-case';
import { PublishExamUseCase } from '../use-cases/publish-exam.use-case';
import { RegradeAttemptUseCase } from '../use-cases/regrade-attempt.use-case';
import { RemoveExamQuestionUseCase } from '../use-cases/remove-exam-question.use-case';
import { UpdateExamQuestionUseCase } from '../use-cases/update-exam-question.use-case';
import { UpdateExamSectionUseCase } from '../use-cases/update-exam-section.use-case';
import { UpdateExamUseCase } from '../use-cases/update-exam.use-case';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('exams')
export class ExamsController {
  constructor(
    private readonly createExamUC: CreateExamUseCase,
    private readonly listExamsUC: ListExamsUseCase,
    private readonly getExamUC: GetExamUseCase,
    private readonly updateExamUC: UpdateExamUseCase,
    private readonly deleteExamUC: DeleteExamUseCase,
    private readonly createSectionUC: CreateExamSectionUseCase,
    private readonly updateSectionUC: UpdateExamSectionUseCase,
    private readonly deleteSectionUC: DeleteExamSectionUseCase,
    private readonly addQuestionsUC: AddQuestionsToExamUseCase,
    private readonly updateExamQuestionUC: UpdateExamQuestionUseCase,
    private readonly removeExamQuestionUC: RemoveExamQuestionUseCase,
    private readonly assignExamUC: AssignExamUseCase,
    private readonly publishExamUC: PublishExamUseCase,
    private readonly closeExamUC: CloseExamUseCase,
    private readonly listAttemptsUC: ListExamAttemptsUseCase,
    private readonly attemptDetailUC: GetExamAttemptDetailUseCase,
    private readonly regradeUC: RegradeAttemptUseCase,
  ) {}

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateExamDto,
  ): Promise<{ data: ExamResponse }> {
    const e = await this.createExamUC.execute({
      actor,
      title: dto.title,
      description: dto.description,
      durationSeconds: dto.durationSeconds,
      defaultNegativeMarks: dto.defaultNegativeMarks,
      randomizeQuestions: dto.randomizeQuestions,
      randomizeOptions: dto.randomizeOptions,
      opensAt: dto.opensAt,
      closesAt: dto.closesAt,
      testMode: dto.testMode,
      programId: dto.programId,
      subjectId: dto.subjectId,
      antiCheatConfig: dto.antiCheatConfig,
    });
    return { data: toExamResponse(e) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get()
  async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListExamsQueryDto,
  ): Promise<PaginatedResponse<ExamResponse>> {
    const r = await this.listExamsUC.execute({
      tenantId: actor.tenantId,
      status: query.status,
      createdBy: query.createdBy,
      programId: query.programId,
      subjectId: query.subjectId,
      q: query.q,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
    return { data: r.data.map(toExamResponse), meta: r.meta };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get(':id')
  async get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ data: ExamDetailResponse }> {
    const d = await this.getExamUC.execute({ tenantId: actor.tenantId, id });
    return { data: toExamDetailResponse(d) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Patch(':id')
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateExamDto,
  ): Promise<{ data: ExamResponse }> {
    const e = await this.updateExamUC.execute({
      actor,
      id,
      title: dto.title,
      description: dto.description,
      durationSeconds: dto.durationSeconds,
      defaultNegativeMarks: dto.defaultNegativeMarks,
      randomizeQuestions: dto.randomizeQuestions,
      randomizeOptions: dto.randomizeOptions,
      opensAt: dto.opensAt,
      closesAt: dto.closesAt,
      antiCheatConfig: dto.antiCheatConfig,
    });
    return { data: toExamResponse(e) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.deleteExamUC.execute({ actor, id });
  }

  // --- Sections ---
  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post(':id/sections')
  @HttpCode(HttpStatus.CREATED)
  async createSection(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateSectionDto,
  ) {
    const s = await this.createSectionUC.execute({
      actor,
      examId: id,
      name: dto.name,
      position: dto.position,
      timeLimitSeconds: dto.timeLimitSeconds,
    });
    return { data: s };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Patch(':id/sections/:sectionId')
  async updateSection(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) _examId: string,
    @Param('sectionId', new ParseUUIDPipe()) sectionId: string,
    @Body() dto: UpdateSectionDto,
  ) {
    const s = await this.updateSectionUC.execute({
      tenantId: actor.tenantId,
      id: sectionId,
      name: dto.name,
      position: dto.position,
      timeLimitSeconds: dto.timeLimitSeconds,
    });
    return { data: s };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Delete(':id/sections/:sectionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeSection(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) _examId: string,
    @Param('sectionId', new ParseUUIDPipe()) sectionId: string,
  ): Promise<void> {
    await this.deleteSectionUC.execute({ tenantId: actor.tenantId, id: sectionId });
  }

  // --- Exam questions ---
  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post(':id/questions')
  @HttpCode(HttpStatus.CREATED)
  async addQuestions(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AddQuestionsToExamDto,
  ) {
    const rows = await this.addQuestionsUC.execute({ actor, examId: id, items: dto.items });
    return { data: rows };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Patch(':id/questions/:examQuestionId')
  async updateExamQuestion(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) examId: string,
    @Param('examQuestionId', new ParseUUIDPipe()) examQuestionId: string,
    @Body() dto: UpdateExamQuestionDto,
  ) {
    const r = await this.updateExamQuestionUC.execute({
      tenantId: actor.tenantId,
      examId,
      id: examQuestionId,
      position: dto.position,
      marks: dto.marks,
      negativeMarks: dto.negativeMarks,
      sectionId: dto.sectionId,
    });
    return { data: r };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Delete(':id/questions/:examQuestionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeExamQuestion(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) _examId: string,
    @Param('examQuestionId', new ParseUUIDPipe()) examQuestionId: string,
  ): Promise<void> {
    await this.removeExamQuestionUC.execute({ tenantId: actor.tenantId, id: examQuestionId });
  }

  // --- Assignments + publish + close ---
  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post(':id/assign')
  async assign(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AssignExamDto,
  ) {
    const rows = await this.assignExamUC.execute({
      actor,
      examId: id,
      classroomIds: dto.classroomIds ?? [],
      studentIds: dto.studentIds ?? [],
    });
    return { data: rows };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post(':id/publish')
  async publish(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const r = await this.publishExamUC.execute({ actor, examId: id });
    return {
      data: {
        exam: toExamResponse(r.exam),
        attemptsCreated: r.attemptsCreated,
        notificationsCreated: r.notificationsCreated,
      },
    };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post(':id/close')
  async close(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const r = await this.closeExamUC.execute({ actor, examId: id });
    return {
      data: {
        exam: toExamResponse(r.exam),
        attemptsAutoSubmitted: r.attemptsAutoSubmitted,
      },
    };
  }

  // --- Attempts ---
  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get(':id/attempts')
  async listAttempts(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const r = await this.listAttemptsUC.execute({
      tenantId: actor.tenantId,
      examId: id,
      limit: Number(limit ?? 100),
      offset: Number(offset ?? 0),
    });
    return {
      data: r.data.map((a) => ({
        id: a.id,
        examId: a.examId,
        studentId: a.studentId,
        status: a.status,
        startedAt: a.startedAt?.toISOString() ?? null,
        submittedAt: a.submittedAt?.toISOString() ?? null,
        gradedAt: a.gradedAt?.toISOString() ?? null,
        score: a.score ? Number(a.score) : null,
        autoSubmitted: a.autoSubmitted,
        violationCount: a.violationCount,
        descriptivePending: a.descriptivePending,
      })),
      meta: { total: r.total, limit: Number(limit ?? 100), offset: Number(offset ?? 0) },
    };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get(':id/attempts/:attemptId')
  async getAttempt(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
  ) {
    const d = await this.attemptDetailUC.execute({
      tenantId: actor.tenantId,
      examId: id,
      attemptId,
    });
    return {
      data: {
        attempt: {
          id: d.attempt.id,
          status: d.attempt.status,
          startedAt: d.attempt.startedAt?.toISOString() ?? null,
          submittedAt: d.attempt.submittedAt?.toISOString() ?? null,
          gradedAt: d.attempt.gradedAt?.toISOString() ?? null,
          score: d.attempt.score ? Number(d.attempt.score) : null,
          autoSubmitted: d.attempt.autoSubmitted,
          violationCount: d.attempt.violationCount,
          descriptivePending: d.attempt.descriptivePending,
        },
        answers: d.answers.map((a) => ({
          id: a.id,
          examQuestionId: a.examQuestionId,
          answerPayload: a.answerPayload,
          isCorrect: a.isCorrect,
          marksAwarded: a.marksAwarded ? Number(a.marksAwarded) : null,
          timeSpentSeconds: a.timeSpentSeconds,
          isFlaggedByStudent: a.isFlaggedByStudent,
        })),
        violations: d.violations.map((v) => ({
          id: v.id,
          type: v.type,
          detail: v.detail,
          clientTimestamp: v.clientTimestamp.toISOString(),
          serverTimestamp: v.serverTimestamp.toISOString(),
        })),
      },
    };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post(':id/attempts/:attemptId/regrade')
  async regrade(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
  ) {
    const r = await this.regradeUC.execute({ actor, examId: id, attemptId });
    return {
      data: {
        score: Number(r.score),
        descriptivePending: r.descriptivePending,
        status: r.attempt.status,
      },
    };
  }
}
