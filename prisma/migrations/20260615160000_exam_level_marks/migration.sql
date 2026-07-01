-- Exam-level marks override (all-or-nothing).
-- `exam_marks_per_question`: when set (non-null), the effective scoring resolver
-- applies this positive value to EVERY question in the exam, ignoring the
-- per-question exam_questions.marks. `exam_negative_marks` is the companion
-- negative (defaults to 0 in the resolver when null but the override is active).
-- When `exam_marks_per_question` is null, scoring falls back to the individual
-- question values. See src/modules/exams/scoring/effective-marks.ts.

-- AlterTable
ALTER TABLE "exams" ADD COLUMN "exam_marks_per_question" DECIMAL(5,2);
ALTER TABLE "exams" ADD COLUMN "exam_negative_marks" DECIMAL(5,2);
