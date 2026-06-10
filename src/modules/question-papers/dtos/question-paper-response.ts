import { PaperRow, PaperWithQuestions } from '../repositories/question-paper.repository';

export interface QuestionPaperResponse {
  id: string;
  title: string;
  description: string | null;
  programId: string | null;
  subjectId: string | null;
  durationSeconds: number;
  defaultNegativeMarks: number;
  totalMarks: number;
  status: string;
  questionCount: number;
  subjects: string[];
  createdBy: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaperQuestionResponse {
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

export interface QuestionPaperDetailResponse extends QuestionPaperResponse {
  questions: PaperQuestionResponse[];
}

export const toPaperResponse = (r: PaperRow): QuestionPaperResponse => ({
  id: r.id,
  title: r.title,
  description: r.description,
  programId: r.programId,
  subjectId: r.subjectId,
  durationSeconds: r.durationSeconds,
  defaultNegativeMarks: r.defaultNegativeMarks,
  totalMarks: r.totalMarks,
  status: r.status,
  questionCount: r.questionCount,
  subjects: r.subjects,
  createdBy: r.createdBy,
  archivedAt: r.archivedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

export const toPaperDetailResponse = (d: PaperWithQuestions): QuestionPaperDetailResponse => ({
  ...toPaperResponse(d.paper),
  questions: d.questions.map((q) => ({
    id: q.id,
    questionId: q.questionId,
    position: q.position,
    marks: q.marks,
    negativeMarks: q.negativeMarks,
    type: q.type,
    difficulty: q.difficulty,
    subject: q.subject,
    topic: q.topic,
    payload: q.payload,
    options: q.options,
  })),
});
