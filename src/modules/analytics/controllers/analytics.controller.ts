import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { Role } from '../../../shared/common/enums/role.enum';
import { StudentResolverService } from '../../attempts/services/student-resolver.service';
import {
  GetExamQuestionStatsUseCase,
  GetExamSummaryUseCase,
  GetQuestionStatsUseCase,
  GetStudentSummaryUseCase,
  GetWeakTopicsForStudentUseCase,
} from '../use-cases/report-query.use-cases';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly examSummaryUC: GetExamSummaryUseCase,
    private readonly examQuestionStatsUC: GetExamQuestionStatsUseCase,
    private readonly studentSummaryUC: GetStudentSummaryUseCase,
    private readonly weakTopicsUC: GetWeakTopicsForStudentUseCase,
    private readonly questionStatsUC: GetQuestionStatsUseCase,
    private readonly resolver: StudentResolverService,
  ) {}

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get('exams/:examId/summary')
  async examSummary(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('examId', new ParseUUIDPipe()) examId: string,
  ) {
    return { data: await this.examSummaryUC.execute({ tenantId: actor.tenantId, examId }) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get('exams/:examId/questions')
  async examQuestions(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('examId', new ParseUUIDPipe()) examId: string,
  ) {
    return {
      data: await this.examQuestionStatsUC.execute({ tenantId: actor.tenantId, examId }),
    };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER, Role.STUDENT)
  @Get('students/:studentId/summary')
  async studentSummary(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('studentId', new ParseUUIDPipe()) studentId: string,
  ) {
    await this.assertStudentSelfOrTeacher(actor, studentId);
    return {
      data: await this.studentSummaryUC.execute({
        tenantId: actor.tenantId,
        studentId,
      }),
    };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER, Role.STUDENT)
  @Get('students/:studentId/weak-topics')
  async weakTopics(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('studentId', new ParseUUIDPipe()) studentId: string,
  ) {
    await this.assertStudentSelfOrTeacher(actor, studentId);
    const rows = await this.weakTopicsUC.execute({ tenantId: actor.tenantId, studentId });
    return {
      data: rows.map((r) => ({
        subject: r.subject,
        topic: r.topic,
        scorePercent: Number(r.scorePercent),
        attemptsCount: r.attemptsCount,
        correctCount: r.correctCount,
        recommendation: `Revise ${r.topic} — currently ${Math.round(Number(r.scorePercent))}% correct`,
      })),
    };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get('questions/:questionId')
  async question(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('questionId', new ParseUUIDPipe()) questionId: string,
  ) {
    const r = await this.questionStatsUC.execute({
      tenantId: actor.tenantId,
      questionId,
    });
    return {
      data: {
        questionId: r.questionId,
        totalAttempts: r.totalAttempts,
        correctAttempts: r.correctAttempts,
        avgTimeSeconds: Number(r.avgTimeSeconds),
        difficultyScore: r.difficultyScore ? Number(r.difficultyScore) : null,
        lastRecomputedAt: r.lastRecomputedAt.toISOString(),
      },
    };
  }

  private async assertStudentSelfOrTeacher(
    actor: AuthenticatedUser,
    studentId: string,
  ): Promise<void> {
    if (actor.role !== Role.STUDENT) return;
    const selfStudentId = await this.resolver.requireStudentIdForUser(actor.tenantId, actor.sub);
    if (selfStudentId !== studentId) {
      throw new ForbiddenException('Students can only read their own analytics');
    }
  }
}
