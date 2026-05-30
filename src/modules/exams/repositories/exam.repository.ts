import { Decimal } from '@prisma/client/runtime/library';
import {
  AntiCheatConfig,
  ExamModel,
  ExamStatus,
  TestMode,
} from '../models/exam.model';
import { ExamAssignmentModel } from '../models/exam-assignment.model';
import { ExamQuestionModel } from '../models/exam-question.model';
import { ExamSectionModel } from '../models/exam-section.model';

export const EXAM_REPOSITORY = Symbol('EXAM_REPOSITORY');

export interface CreateExamInput {
  tenantId: string;
  createdBy: string;
  title: string;
  description?: string | null;
  durationSeconds: number;
  defaultNegativeMarks?: number;
  randomizeQuestions?: boolean;
  randomizeOptions?: boolean;
  opensAt?: Date | null;
  closesAt?: Date | null;
  testMode?: TestMode;
  programId?: string | null;
  subjectId?: string | null;
  antiCheatConfig?: Partial<AntiCheatConfig>;
}

export interface UpdateExamInput {
  title?: string;
  description?: string | null;
  durationSeconds?: number;
  defaultNegativeMarks?: number;
  randomizeQuestions?: boolean;
  randomizeOptions?: boolean;
  opensAt?: Date | null;
  closesAt?: Date | null;
  programId?: string | null;
  subjectId?: string | null;
  antiCheatConfig?: Partial<AntiCheatConfig>;
}

export interface ListExamsFilter {
  tenantId: string;
  status?: ExamStatus;
  createdBy?: string;
  programId?: string;
  subjectId?: string;
  q?: string;
  limit: number;
  offset: number;
}

export interface ExamDetail {
  exam: ExamModel;
  sections: ExamSectionModel[];
  questions: ExamQuestionModel[];
  assignments: ExamAssignmentModel[];
}

export interface IExamRepository {
  create(input: CreateExamInput): Promise<ExamModel>;
  findById(tenantId: string, id: string): Promise<ExamModel | null>;
  findByIdAnyTenant(id: string): Promise<ExamModel | null>;
  findDetail(tenantId: string, id: string): Promise<ExamDetail | null>;
  list(filter: ListExamsFilter): Promise<{ data: ExamModel[]; total: number }>;
  update(tenantId: string, id: string, input: UpdateExamInput): Promise<ExamModel>;
  delete(tenantId: string, id: string): Promise<void>;

  setStatus(tenantId: string, id: string, status: ExamStatus, publishedAt?: Date | null): Promise<ExamModel>;
  recomputeTotalMarks(tenantId: string, id: string): Promise<Decimal>;

  // Sections
  createSection(input: {
    tenantId: string;
    examId: string;
    name: string;
    position: number;
    timeLimitSeconds?: number | null;
  }): Promise<ExamSectionModel>;
  updateSection(tenantId: string, id: string, input: {
    name?: string;
    position?: number;
    timeLimitSeconds?: number | null;
  }): Promise<ExamSectionModel>;
  deleteSection(tenantId: string, id: string): Promise<void>;

  // Exam questions
  addExamQuestions(input: {
    tenantId: string;
    examId: string;
    items: Array<{
      questionId: string;
      sectionId?: string | null;
      position: number;
      marks: number;
      negativeMarks?: number;
    }>;
  }): Promise<ExamQuestionModel[]>;
  updateExamQuestion(tenantId: string, id: string, input: {
    position?: number;
    marks?: number;
    negativeMarks?: number;
    sectionId?: string | null;
  }): Promise<ExamQuestionModel>;
  removeExamQuestion(tenantId: string, id: string): Promise<{ examId: string }>;

  // Assignments
  createAssignments(input: {
    tenantId: string;
    examId: string;
    classroomIds: string[];
    studentIds: string[];
  }): Promise<ExamAssignmentModel[]>;

  // Expand assignment → list of student ids for attempt creation.
  expandAssignmentsToStudentIds(tenantId: string, examId: string): Promise<string[]>;
}
