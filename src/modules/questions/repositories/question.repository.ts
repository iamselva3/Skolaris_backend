import { Difficulty, QuestionType } from '../models/question-type.enum';
import { QuestionWithOptions } from '../models/question.model';

export const QUESTION_REPOSITORY = Symbol('QUESTION_REPOSITORY');

export interface CreateQuestionInput {
  tenantId: string;
  createdBy: string;
  sourceUploadId?: string | null;
  type: QuestionType;
  payload: Record<string, unknown>;
  programId?: string | null;
  subjectId?: string | null;
  topicId?: string | null;
  chapterId?: string | null;
  subject?: string | null;
  topic?: string | null;
  chapter?: string | null;
  difficulty?: Difficulty;
  options?: { label: string; isCorrect: boolean; position: number }[];
}

export interface UpdateQuestionInput {
  payload?: Record<string, unknown>;
  programId?: string | null;
  subjectId?: string | null;
  topicId?: string | null;
  chapterId?: string | null;
  subject?: string | null;
  topic?: string | null;
  chapter?: string | null;
  difficulty?: Difficulty;
  isActive?: boolean;
  options?: { label: string; isCorrect: boolean; position: number }[];
}

export interface ListQuestionsFilter {
  tenantId: string;
  programId?: string;
  subjectId?: string;
  topicId?: string;
  chapterId?: string;
  subject?: string;
  topic?: string;
  difficulty?: Difficulty;
  type?: QuestionType;
  q?: string;
  isActive?: boolean;
  limit: number;
  offset: number;
}

export interface IQuestionRepository {
  create(input: CreateQuestionInput): Promise<QuestionWithOptions>;
  findById(tenantId: string, id: string): Promise<QuestionWithOptions | null>;
  list(filter: ListQuestionsFilter): Promise<{ data: QuestionWithOptions[]; total: number }>;
  update(tenantId: string, id: string, input: UpdateQuestionInput): Promise<QuestionWithOptions>;
  softDelete(tenantId: string, id: string): Promise<void>;
  countActive(tenantId: string, createdBy?: string): Promise<number>;
}
