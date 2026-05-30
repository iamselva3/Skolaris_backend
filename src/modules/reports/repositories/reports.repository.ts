import {
  ClassReportRow,
  ExamReportHeader,
  ExamReportRow,
  QuestionMeta,
  QuestionReportRow,
  ReportsOverview,
  StudentReportDetail,
  StudentReportRow,
  TopicRollupRow,
} from '../models/report.models';

export const REPORTS_REPOSITORY = Symbol('REPORTS_REPOSITORY');

/**
 * Normalized filter set shared by every report query. `limit`/`offset` are
 * resolved (defaulted) before reaching the repository. `createdBy`, when set,
 * scopes exam/question rows to a single teacher (tenant-wide otherwise).
 */
export interface ReportFilters {
  dateFrom?: string;
  dateTo?: string;
  programId?: string;
  subjectId?: string;
  topicId?: string;
  chapterId?: string;
  branchId?: string;
  classroomId?: string;
  q?: string;
  limit: number;
  offset: number;
}

export interface Paged<T> {
  rows: T[];
  total: number;
}

export interface IReportsRepository {
  getOverview(tenantId: string, createdBy?: string): Promise<ReportsOverview>;

  listExamReports(
    tenantId: string,
    createdBy: string | undefined,
    f: ReportFilters,
  ): Promise<Paged<ExamReportRow>>;
  getExamHeader(tenantId: string, examId: string): Promise<ExamReportHeader>;
  getQuestionMeta(tenantId: string, questionIds: string[]): Promise<Map<string, QuestionMeta>>;

  listStudentReports(tenantId: string, f: ReportFilters): Promise<Paged<StudentReportRow>>;
  getStudentDetail(tenantId: string, studentId: string): Promise<StudentReportDetail>;

  listTopicReports(
    tenantId: string,
    f: ReportFilters,
    weakOnly: boolean,
  ): Promise<Paged<TopicRollupRow>>;

  listQuestionReports(
    tenantId: string,
    createdBy: string | undefined,
    f: ReportFilters,
  ): Promise<Paged<QuestionReportRow>>;

  listClassReports(tenantId: string, f: ReportFilters): Promise<Paged<ClassReportRow>>;
}
