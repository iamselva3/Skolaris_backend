import { Decimal } from '@prisma/client/runtime/library';
import { hasExamLevelMarks, resolveEffectiveMarks } from './effective-marks';

const d = (n: number): Decimal => new Decimal(n);

describe('resolveEffectiveMarks', () => {
  const question = { marks: d(2), negativeMarks: d(0.5) };

  it('uses exam-level values for every question when the override is set (Example 1)', () => {
    const exam = { examMarksPerQuestion: d(4), examNegativeMarks: d(1) };
    const r = resolveEffectiveMarks(exam, question);
    expect(r.source).toBe('EXAM');
    expect(r.marks.toNumber()).toBe(4);
    expect(r.negativeMarks.toNumber()).toBe(1);
  });

  it('falls back to per-question values when no override is set (Example 2)', () => {
    const exam = { examMarksPerQuestion: null, examNegativeMarks: null };
    const r = resolveEffectiveMarks(exam, question);
    expect(r.source).toBe('QUESTION');
    expect(r.marks.toNumber()).toBe(2);
    expect(r.negativeMarks.toNumber()).toBe(0.5);
  });

  it('treats a 0 exam-level mark as a configured override (not a fallback)', () => {
    const exam = { examMarksPerQuestion: d(0), examNegativeMarks: null };
    const r = resolveEffectiveMarks(exam, question);
    expect(r.source).toBe('EXAM');
    expect(r.marks.toNumber()).toBe(0);
  });

  it('defaults exam negative to 0 when the override is set but negative is null (all-or-nothing)', () => {
    const exam = { examMarksPerQuestion: d(4), examNegativeMarks: null };
    const r = resolveEffectiveMarks(exam, question);
    expect(r.source).toBe('EXAM');
    expect(r.marks.toNumber()).toBe(4);
    expect(r.negativeMarks.toNumber()).toBe(0);
  });

  it('hasExamLevelMarks reflects whether the positive override is set', () => {
    expect(hasExamLevelMarks({ examMarksPerQuestion: d(4), examNegativeMarks: null })).toBe(true);
    expect(hasExamLevelMarks({ examMarksPerQuestion: d(0), examNegativeMarks: null })).toBe(true);
    expect(hasExamLevelMarks({ examMarksPerQuestion: null, examNegativeMarks: d(1) })).toBe(false);
  });
});
