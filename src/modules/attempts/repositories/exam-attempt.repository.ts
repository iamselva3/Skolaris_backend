import { Decimal } from '@prisma/client/runtime/library';
import { AttemptAnswerModel } from '../models/attempt-answer.model';
import { AttemptStatus, ExamAttemptModel } from '../models/exam-attempt.model';

export const EXAM_ATTEMPT_REPOSITORY = Symbol('EXAM_ATTEMPT_REPOSITORY');

export interface BulkCreateAttemptInput {
  tenantId: string;
  examId: string;
  studentIds: string[];
}

export interface UpsertAnswerInput {
  tenantId: string;
  attemptId: string;
  examQuestionId: string;
  answerPayload: Record<string, unknown> | null;
  timeSpentSeconds?: number;
  isFlagged?: boolean;
}

export interface ListAttemptsFilter {
  tenantId: string;
  examId?: string;
  studentId?: string;
  status?: AttemptStatus;
  limit?: number;
  offset?: number;
}

export interface IExamAttemptRepository {
  bulkCreate(input: BulkCreateAttemptInput): Promise<number>;
  findById(tenantId: string, id: string): Promise<ExamAttemptModel | null>;
  findByIdAnyTenant(id: string): Promise<ExamAttemptModel | null>;
  findByExamAndStudent(
    tenantId: string,
    examId: string,
    studentId: string,
  ): Promise<ExamAttemptModel | null>;
  list(filter: ListAttemptsFilter): Promise<{ data: ExamAttemptModel[]; total: number }>;
  listForStudent(
    tenantId: string,
    studentId: string,
  ): Promise<ExamAttemptModel[]>;
  start(input: {
    tenantId: string;
    id: string;
    timeRemainingSeconds: number;
  }): Promise<ExamAttemptModel>;
  saveProgress(input: {
    tenantId: string;
    id: string;
    timeRemainingSeconds: number;
  }): Promise<ExamAttemptModel>;
  submit(input: {
    tenantId: string;
    id: string;
    autoSubmitted?: boolean;
  }): Promise<ExamAttemptModel>;
  setStatus(
    tenantId: string,
    id: string,
    status: AttemptStatus,
  ): Promise<ExamAttemptModel>;
  setGradedScore(input: {
    tenantId: string;
    id: string;
    score: Decimal;
    descriptivePending: boolean;
  }): Promise<ExamAttemptModel>;
  incrementViolationCount(
    tenantId: string,
    id: string,
    delta: number,
  ): Promise<ExamAttemptModel>;
  findExpiredInProgress(now: Date): Promise<ExamAttemptModel[]>;

  // Answers
  upsertAnswer(input: UpsertAnswerInput): Promise<AttemptAnswerModel>;
  listAnswers(tenantId: string, attemptId: string): Promise<AttemptAnswerModel[]>;
  updateAnswerGrading(input: {
    tenantId: string;
    answerId: string;
    isCorrect: boolean | null;
    marksAwarded: Decimal | null;
  }): Promise<void>;
}
