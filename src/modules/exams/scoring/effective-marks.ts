import { Decimal } from '@prisma/client/runtime/library';

/**
 * SINGLE SOURCE OF TRUTH for "what marks apply to a question in this exam".
 *
 * Two ways marks can be configured coexist:
 *   1. Exam-level (all-or-nothing): if `examMarksPerQuestion` is set, EVERY
 *      question scores +examMarksPerQuestion / -(examNegativeMarks ?? 0).
 *   2. Per-question: otherwise each question uses its own ExamQuestion.marks /
 *      negativeMarks.
 *
 * Every module that computes a score — exam conduct/grading, totalMarks,
 * analytics, reports, leaderboards, rankings — MUST resolve marks through this
 * function. Do not re-implement the precedence anywhere else.
 *
 * Unanswered handling (score 0, never negative) is NOT this function's concern —
 * that lives in the grading strategies; this only decides the marks magnitudes.
 */

const ZERO = new Decimal(0);

/** The exam-level override knobs (a subset of the Exam row). */
export interface ExamMarksConfig {
  examMarksPerQuestion: Decimal | null;
  examNegativeMarks: Decimal | null;
}

/** The per-question marks (from an ExamQuestion row). */
export interface QuestionMarksConfig {
  marks: Decimal;
  negativeMarks: Decimal;
}

export interface EffectiveMarks {
  marks: Decimal;
  negativeMarks: Decimal;
  /** Which side of the precedence won — useful for debugging / display. */
  source: 'EXAM' | 'QUESTION';
}

/** True when this exam has a configured exam-level marks override. */
export function hasExamLevelMarks(exam: ExamMarksConfig): boolean {
  return exam.examMarksPerQuestion !== null && exam.examMarksPerQuestion !== undefined;
}

/**
 * Resolve the effective positive/negative marks for a single question, applying
 * exam-level-over-question precedence.
 */
export function resolveEffectiveMarks(
  exam: ExamMarksConfig,
  question: QuestionMarksConfig,
): EffectiveMarks {
  if (hasExamLevelMarks(exam)) {
    return {
      marks: exam.examMarksPerQuestion as Decimal,
      negativeMarks: exam.examNegativeMarks ?? ZERO,
      source: 'EXAM',
    };
  }
  return {
    marks: question.marks,
    negativeMarks: question.negativeMarks,
    source: 'QUESTION',
  };
}
