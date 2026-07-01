import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { Role } from '../../../shared/common/enums/role.enum';
import {
  EXAM_ANALYTICS_REPOSITORY,
  ExamDeepAnalytics,
  ExamHeatmap,
  ExamStudentBreakdown,
  ExamStudentsPage,
  ExamStudentsQuery,
  IExamAnalyticsRepository,
} from '../repositories/exam-analytics.repository';

/**
 * Exam-specific deep analytics. A TEACHER may only analyse exams they created;
 * SUPER_ADMIN is tenant-wide. Ownership is checked against the exam header
 * before any heavy aggregation runs.
 */
@Injectable()
export class ExamAnalyticsUseCases {
  constructor(
    @Inject(EXAM_ANALYTICS_REPOSITORY) private readonly repo: IExamAnalyticsRepository,
  ) {}

  private async assertAccess(actor: AuthenticatedUser, examId: string): Promise<void> {
    const header = await this.repo.getHeader(actor.tenantId, examId);
    if (!header) throw new NotFoundException('Exam not found');
    if (actor.role === Role.TEACHER && header.createdBy !== actor.sub) {
      throw new ForbiddenException('You can only view reports for exams you created');
    }
  }

  async analytics(actor: AuthenticatedUser, examId: string): Promise<ExamDeepAnalytics> {
    await this.assertAccess(actor, examId);
    const result = await this.repo.getDeepAnalytics(actor.tenantId, examId);
    if (!result) throw new NotFoundException('Exam not found');
    return result;
  }

  async students(
    actor: AuthenticatedUser,
    examId: string,
    query: ExamStudentsQuery,
  ): Promise<ExamStudentsPage> {
    await this.assertAccess(actor, examId);
    return this.repo.getStudents(actor.tenantId, examId, query);
  }

  async breakdown(
    actor: AuthenticatedUser,
    examId: string,
    studentId: string,
  ): Promise<ExamStudentBreakdown> {
    await this.assertAccess(actor, examId);
    const result = await this.repo.getStudentBreakdown(actor.tenantId, examId, studentId);
    if (!result) throw new NotFoundException('No attempt found for this student');
    return result;
  }

  async heatmap(
    actor: AuthenticatedUser,
    examId: string,
    limit: number,
    offset: number,
  ): Promise<ExamHeatmap> {
    await this.assertAccess(actor, examId);
    return this.repo.getHeatmap(actor.tenantId, examId, limit, offset);
  }
}
