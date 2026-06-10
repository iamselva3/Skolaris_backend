import { QuestionPaperStatus } from '@prisma/client';

export const QUESTION_PAPER_REPOSITORY = Symbol('QUESTION_PAPER_REPOSITORY');

export interface CreatePaperInput {
  tenantId: string;
  branchId: string | null;
  createdBy: string;
  title: string;
  description?: string | null;
  programId?: string | null;
  subjectId?: string | null;
  durationSeconds: number;
  defaultNegativeMarks?: number;
}

export interface UpdatePaperInput {
  title?: string;
  description?: string | null;
  programId?: string | null;
  subjectId?: string | null;
  durationSeconds?: number;
  defaultNegativeMarks?: number;
  status?: QuestionPaperStatus;
  archivedAt?: Date | null;
}

export interface PaperQuestionInput {
  questionId: string;
  marks?: number;
  negativeMarks?: number;
}

/** One random-selection rule: draw `count` questions matching the filters. */
export interface GenerateRule {
  subjectId?: string;
  chapterId?: string;
  topicId?: string;
  difficulty?: 'EASY' | 'MEDIUM' | 'HARD';
  count: number;
}

export interface PaperListFilter {
  tenantId: string;
  createdBy?: string; // TEACHER scoping
  status?: QuestionPaperStatus;
  includeArchived?: boolean;
  programId?: string;
  subjectId?: string;
  q?: string;
  limit: number;
  offset: number;
}

/** A paper row enriched for the list view. */
export interface PaperRow {
  id: string;
  tenantId: string;
  branchId: string | null;
  createdBy: string;
  title: string;
  description: string | null;
  programId: string | null;
  subjectId: string | null;
  durationSeconds: number;
  defaultNegativeMarks: number;
  totalMarks: number;
  status: QuestionPaperStatus;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  questionCount: number;
  subjects: string[];
}

/** A single paper-question joined with its bank Question for preview. */
export interface PaperQuestionRow {
  id: string;
  questionId: string;
  position: number;
  marks: number;
  negativeMarks: number;
  type: string;
  difficulty: string;
  subject: string | null;
  topic: string | null;
  payload: Record<string, unknown>;
  options: Array<{ id: string; label: string; isCorrect: boolean; position: number }>;
}

export interface PaperWithQuestions {
  paper: PaperRow;
  questions: PaperQuestionRow[];
}

export interface PaperSummary {
  total: number;
  draft: number;
  published: number;
  archived: number;
}

export interface IQuestionPaperRepository {
  create(input: CreatePaperInput): Promise<PaperRow>;
  list(filter: PaperListFilter): Promise<{ data: PaperRow[]; total: number }>;
  summary(tenantId: string, createdBy?: string): Promise<PaperSummary>;
  findById(tenantId: string, id: string): Promise<PaperRow | null>;
  findByIdWithQuestions(tenantId: string, id: string): Promise<PaperWithQuestions | null>;
  update(tenantId: string, id: string, input: UpdatePaperInput): Promise<PaperRow>;
  delete(tenantId: string, id: string): Promise<void>;
  clone(
    tenantId: string,
    id: string,
    newCreatedBy: string,
    branchId: string | null,
  ): Promise<PaperRow>;
  /** Bulk add (skips questions already on the paper); appends at the end; recomputes totalMarks. */
  addQuestions(tenantId: string, paperId: string, items: PaperQuestionInput[]): Promise<PaperRow>;
  removeQuestion(tenantId: string, paperId: string, questionId: string): Promise<PaperRow>;
  reorder(
    tenantId: string,
    paperId: string,
    order: Array<{ questionId: string; position: number }>,
  ): Promise<void>;
  /** Random selection: for each rule draw N random active bank questions, excluding those already on the paper. Returns count added. */
  generate(tenantId: string, paperId: string, rules: GenerateRule[]): Promise<number>;
}
