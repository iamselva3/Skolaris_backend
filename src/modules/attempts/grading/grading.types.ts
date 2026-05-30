import { Decimal } from '@prisma/client/runtime/library';
import { QuestionType } from '../../questions/models/question-type.enum';

export interface GradingQuestion {
  type: QuestionType;
  payload: Record<string, unknown>;
  options: Array<{ id: string; label: string; isCorrect: boolean; position: number }>;
  marks: Decimal;
  negativeMarks: Decimal;
}

export interface GradingAnswer {
  payload: Record<string, unknown> | null;
}

export interface GradingResult {
  /**
   * `null` for DESCRIPTIVE (manual grading) — caller must mark attempt as
   * `descriptivePending = true`.
   */
  isCorrect: boolean | null;
  marksAwarded: Decimal;
}

export interface IGradingStrategy {
  grade(question: GradingQuestion, answer: GradingAnswer): GradingResult;
}
