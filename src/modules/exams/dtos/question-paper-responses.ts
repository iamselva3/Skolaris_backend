import { ExamModel } from '../models/exam.model';
import { ExamResponse, toExamResponse } from './exam-responses';
import { CompositionStatus } from './question-paper.dtos';

export interface QuestionPaperRow {
  exam: ExamModel;
  questionCount: number;
  subjects: string[]; // distinct subject names (Exam.subjectId + ExamQuestion → Question → Subject)
  course: string | null; // Program name
}

export interface QuestionPaperResponse extends ExamResponse {
  questionCount: number;
  subjects: string[];
  course: string | null;
  compositionStatus: CompositionStatus;
}

export interface QuestionPapersSummary {
  total: number;
  draft: number;
  inProgress: number;
  completed: number;
}

/**
 * Derives composition status of a Question Paper from question count + metadata
 * completeness. With kind=PAPER (forced by buildPaperWhere) and the use-case
 * guards that prevent papers from leaving DRAFT, the rule is pure:
 *
 *   0 questions                                  → 'DRAFT'
 *   questions but incomplete metadata/schedule   → 'IN_PROGRESS'
 *   questions + complete metadata/schedule       → 'COMPLETED'
 *
 * It DOES NOT look at exam.status — Papers never transition past DRAFT, and
 * Test statuses (SCHEDULED/LIVE/CLOSED) belong to a different asset class.
 */
export const computeCompositionStatus = (
  exam: Pick<ExamModel, 'totalMarks' | 'opensAt' | 'closesAt'>,
  questionCount: number,
): CompositionStatus => {
  if (questionCount === 0) return 'DRAFT';
  const tm = Number(exam.totalMarks);
  const incomplete = tm === 0 || !exam.opensAt || !exam.closesAt;
  return incomplete ? 'IN_PROGRESS' : 'COMPLETED';
};

export const toQuestionPaperResponse = (row: QuestionPaperRow): QuestionPaperResponse => ({
  ...toExamResponse(row.exam),
  questionCount: row.questionCount,
  subjects: row.subjects,
  course: row.course,
  compositionStatus: computeCompositionStatus(row.exam, row.questionCount),
});
