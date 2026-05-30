import { Decimal } from '@prisma/client/runtime/library';
import { QuestionStatModel, TopicReportModel } from '../models/analytics.models';

export const ANALYTICS_REPOSITORY = Symbol('ANALYTICS_REPOSITORY');

export interface UpsertQuestionStatInput {
  questionId: string;
  tenantId: string;
  totalAttempts: number;
  correctAttempts: number;
  avgTimeSeconds: Decimal;
  difficultyScore: Decimal | null;
}

export interface UpsertTopicReportInput {
  tenantId: string;
  studentId: string;
  subject: string;
  topic: string;
  attemptsCount: number;
  correctCount: number;
  scorePercent: Decimal;
  isWeak: boolean;
}

export interface ExamQuestionStatRow {
  examQuestionId: string;
  questionId: string;
  totalAnswered: number;
  correctCount: number;
  avgTimeSeconds: number;
  flag: 'too_easy' | 'too_hard' | 'ambiguous' | 'normal';
}

export interface IAnalyticsRepository {
  upsertQuestionStat(input: UpsertQuestionStatInput): Promise<QuestionStatModel>;
  upsertTopicReport(input: UpsertTopicReportInput): Promise<TopicReportModel>;
  getQuestionStat(tenantId: string, questionId: string): Promise<QuestionStatModel | null>;

  // Compute fresh aggregate from raw answers — used by the analytics worker.
  computeQuestionAggregate(
    tenantId: string,
    questionId: string,
  ): Promise<{ total: number; correct: number; avgTime: number }>;

  computeStudentTopicAggregates(
    tenantId: string,
    studentId: string,
  ): Promise<Array<{ subject: string; topic: string; total: number; correct: number }>>;

  // Reports
  getExamSummary(tenantId: string, examId: string): Promise<{
    totalAttempts: number;
    submittedCount: number;
    gradedCount: number;
    avgScore: number;
    distribution: Array<{ bucket: string; count: number }>;
  }>;

  getExamQuestionStats(tenantId: string, examId: string): Promise<ExamQuestionStatRow[]>;

  getStudentSummary(tenantId: string, studentId: string): Promise<{
    attemptsTotal: number;
    avgScore: number;
    weakTopicsCount: number;
  }>;

  getWeakTopics(tenantId: string, studentId: string): Promise<TopicReportModel[]>;
}
