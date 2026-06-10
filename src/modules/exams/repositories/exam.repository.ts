import { Decimal } from '@prisma/client/runtime/library';
import { AntiCheatConfig, ExamKind, ExamModel, ExamStatus, TestMode } from '../models/exam.model';
import { ExamAssignmentModel } from '../models/exam-assignment.model';
import { ExamQuestionModel } from '../models/exam-question.model';
import { ExamSectionModel } from '../models/exam-section.model';
import { CompositionStatus } from '../dtos/question-paper.dtos';
import { QuestionPaperRow, QuestionPapersSummary } from '../dtos/question-paper-responses';

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
  /** Defaults to TEST at the persistence layer. Set 'PAPER' for question papers. */
  kind?: ExamKind;
  /** Provenance when this exam is snapshotted from a standalone QuestionPaper. */
  sourcePaperId?: string | null;
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
  /** Defaults to 'TEST' in the use-case layer so the existing /exams list never surfaces papers. */
  kind?: ExamKind;
  limit: number;
  offset: number;
}

export interface ListQuestionPapersFilter {
  tenantId: string;
  compositionStatus?: CompositionStatus;
  createdBy?: string;
  programId?: string;
  subjectId?: string;
  classroomId?: string;
  section?: string;
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

  setStatus(
    tenantId: string,
    id: string,
    status: ExamStatus,
    publishedAt?: Date | null,
  ): Promise<ExamModel>;
  recomputeTotalMarks(tenantId: string, id: string): Promise<Decimal>;

  // Sections
  createSection(input: {
    tenantId: string;
    examId: string;
    name: string;
    position: number;
    timeLimitSeconds?: number | null;
  }): Promise<ExamSectionModel>;
  updateSection(
    tenantId: string,
    id: string,
    input: {
      name?: string;
      position?: number;
      timeLimitSeconds?: number | null;
    },
  ): Promise<ExamSectionModel>;
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
  updateExamQuestion(
    tenantId: string,
    id: string,
    input: {
      position?: number;
      marks?: number;
      negativeMarks?: number;
      sectionId?: string | null;
    },
  ): Promise<ExamQuestionModel>;
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

  // ---- Manage Question Papers -------------------------------------------
  /** Listing with denormalized question count + distinct subject names + course name per row. */
  listWithCounts(
    filter: ListQuestionPapersFilter,
  ): Promise<{ data: QuestionPaperRow[]; total: number }>;
  /** KPI summary (total / draft / in-progress / completed) — derived counts. */
  summarizeQuestionPapers(input: {
    tenantId: string;
    createdBy?: string;
  }): Promise<QuestionPapersSummary>;
  /**
   * Deep-clone an Exam + its sections + ExamQuestion rows as a new DRAFT (questionRefs are reused, not copied).
   * If `kind` is omitted, the source's kind is preserved (paper → paper). Pass `kind='TEST'` to convert
   * a question paper into a fresh test (the "Create Test from Paper" path).
   */
  cloneExam(input: {
    tenantId: string;
    sourceId: string;
    newCreatedBy: string;
    kind?: ExamKind;
  }): Promise<ExamModel>;
}
