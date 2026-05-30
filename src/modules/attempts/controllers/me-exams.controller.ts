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
import { HeartbeatDto, UpsertAnswerDto } from '../dtos/attempt.dtos';
import { StudentResolverService } from '../services/student-resolver.service';
import { GetAttemptResultUseCase } from '../use-cases/get-attempt-result.use-case';
import { GetMyAttemptUseCase } from '../use-cases/get-my-attempt.use-case';
import { GetMyExamUseCase } from '../use-cases/get-my-exam.use-case';
import { HeartbeatAttemptUseCase } from '../use-cases/heartbeat-attempt.use-case';
import { ListMyExamsUseCase } from '../use-cases/list-my-exams.use-case';
import { StartAttemptUseCase } from '../use-cases/start-attempt.use-case';
import { SubmitAttemptUseCase } from '../use-cases/submit-attempt.use-case';
import { UpsertAttemptAnswerUseCase } from '../use-cases/upsert-attempt-answer.use-case';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.STUDENT)
@Controller('me')
export class MeExamsController {
  constructor(
    private readonly resolver: StudentResolverService,
    private readonly listMyExamsUC: ListMyExamsUseCase,
    private readonly getMyExamUC: GetMyExamUseCase,
    private readonly startAttemptUC: StartAttemptUseCase,
    private readonly getMyAttemptUC: GetMyAttemptUseCase,
    private readonly upsertAnswerUC: UpsertAttemptAnswerUseCase,
    private readonly heartbeatUC: HeartbeatAttemptUseCase,
    private readonly submitUC: SubmitAttemptUseCase,
    private readonly resultUC: GetAttemptResultUseCase,
  ) {}

  @Get('exams')
  async listMyExams(@CurrentUser() actor: AuthenticatedUser) {
    const studentId = await this.resolver.requireStudentIdForUser(actor.tenantId, actor.sub);
    const data = await this.listMyExamsUC.execute({ tenantId: actor.tenantId, studentId });
    return { data };
  }

  @Get('exams/:examId')
  async getMyExam(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('examId', new ParseUUIDPipe()) examId: string,
  ) {
    const studentId = await this.resolver.requireStudentIdForUser(actor.tenantId, actor.sub);
    const data = await this.getMyExamUC.execute({
      tenantId: actor.tenantId,
      studentId,
      examId,
    });
    return { data };
  }

  @Post('exams/:examId/start')
  @HttpCode(HttpStatus.OK)
  async start(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('examId', new ParseUUIDPipe()) examId: string,
  ) {
    const studentId = await this.resolver.requireStudentIdForUser(actor.tenantId, actor.sub);
    const r = await this.startAttemptUC.execute({
      tenantId: actor.tenantId,
      studentId,
      examId,
    });
    return {
      data: {
        attempt: {
          id: r.attempt.id,
          status: r.attempt.status,
          timeRemainingSeconds: r.attempt.timeRemainingSeconds,
          startedAt: r.attempt.startedAt?.toISOString() ?? null,
        },
        questions: r.questions,
      },
    };
  }

  @Get('attempts/:attemptId')
  async getMyAttempt(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
  ) {
    const studentId = await this.resolver.requireStudentIdForUser(actor.tenantId, actor.sub);
    const d = await this.getMyAttemptUC.execute({
      tenantId: actor.tenantId,
      studentId,
      attemptId,
    });
    return {
      data: {
        attempt: {
          id: d.attempt.id,
          status: d.attempt.status,
          timeRemainingSeconds: d.attempt.timeRemainingSeconds,
          startedAt: d.attempt.startedAt?.toISOString() ?? null,
        },
        answers: d.answers.map((a) => ({
          examQuestionId: a.examQuestionId,
          answerPayload: a.answerPayload,
          timeSpentSeconds: a.timeSpentSeconds,
          isFlaggedByStudent: a.isFlaggedByStudent,
        })),
      },
    };
  }

  @Patch('attempts/:attemptId/answers/:examQuestionId')
  async upsertAnswer(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
    @Param('examQuestionId', new ParseUUIDPipe()) examQuestionId: string,
    @Body() dto: UpsertAnswerDto,
  ) {
    const studentId = await this.resolver.requireStudentIdForUser(actor.tenantId, actor.sub);
    const a = await this.upsertAnswerUC.execute({
      tenantId: actor.tenantId,
      studentId,
      attemptId,
      examQuestionId,
      answerPayload: dto.answerPayload ?? null,
      timeSpentSeconds: dto.timeSpentSeconds,
      isFlagged: dto.isFlagged,
    });
    return {
      data: {
        examQuestionId: a.examQuestionId,
        timeSpentSeconds: a.timeSpentSeconds,
        isFlaggedByStudent: a.isFlaggedByStudent,
      },
    };
  }

  @Post('attempts/:attemptId/heartbeat')
  @HttpCode(HttpStatus.OK)
  async heartbeat(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
    @Body() dto: HeartbeatDto,
  ) {
    const studentId = await this.resolver.requireStudentIdForUser(actor.tenantId, actor.sub);
    const r = await this.heartbeatUC.execute({
      tenantId: actor.tenantId,
      studentId,
      attemptId,
      clientTimeRemainingSeconds: dto.clientTimeRemainingSeconds,
    });
    return { data: r };
  }

  @Post('attempts/:attemptId/submit')
  @HttpCode(HttpStatus.OK)
  async submit(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
  ) {
    const studentId = await this.resolver.requireStudentIdForUser(actor.tenantId, actor.sub);
    const r = await this.submitUC.execute({
      tenantId: actor.tenantId,
      studentId,
      attemptId,
    });
    return {
      data: {
        attemptId: r.id,
        submittedAt: r.submittedAt?.toISOString() ?? null,
        status: r.status,
      },
    };
  }

  @Get('attempts/:attemptId/result')
  async result(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
  ) {
    const studentId = await this.resolver.requireStudentIdForUser(actor.tenantId, actor.sub);
    const r = await this.resultUC.execute({
      tenantId: actor.tenantId,
      studentId,
      attemptId,
    });
    return { data: r };
  }
}
