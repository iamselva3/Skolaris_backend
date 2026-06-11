import { QuestionWithOptions } from '../models/question.model';

export interface QuestionOptionResponse {
  id: string;
  label: string;
  isCorrect: boolean;
  position: number;
}

export interface QuestionResponse {
  id: string;
  tenantId: string;
  createdBy: string;
  sourceUploadId: string | null;
  type: string;
  payload: Record<string, unknown>;
  programId: string | null;
  subjectId: string | null;
  topicId: string | null;
  chapterId: string | null;
  subject: string | null;
  topic: string | null;
  chapter?: string | null;
  difficulty: string;
  isActive: boolean;
  options: QuestionOptionResponse[];
  createdAt: string;
  updatedAt: string;
}

export const toQuestionResponse = ({
  question,
  options,
}: QuestionWithOptions): QuestionResponse => ({
  id: question.id,
  tenantId: question.tenantId,
  createdBy: question.createdBy,
  sourceUploadId: question.sourceUploadId,
  type: question.type,
  payload: question.payload,
  programId: question.programId,
  subjectId: question.subjectId,
  topicId: question.topicId,
  chapterId: question.chapterId,
  subject: question.subject,
  topic: question.topic,
  chapter: question.chapter,
  difficulty: question.difficulty,
  isActive: question.isActive,
  options: options.map((o) => ({
    id: o.id,
    label: o.label,
    isCorrect: o.isCorrect,
    position: o.position,
  })),
  createdAt: question.createdAt.toISOString(),
  updatedAt: question.updatedAt.toISOString(),
});
