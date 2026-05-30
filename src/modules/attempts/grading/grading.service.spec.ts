import { Decimal } from '@prisma/client/runtime/library';
import { QuestionType } from '../../questions/models/question-type.enum';
import { GradingService } from './grading.service';
import { GradingQuestion } from './grading.types';

const svc = new GradingService();

const baseQ = (overrides: Partial<GradingQuestion>): GradingQuestion => ({
  type: QuestionType.SINGLE_CHOICE,
  payload: {},
  options: [],
  marks: new Decimal(4),
  negativeMarks: new Decimal(1),
  ...overrides,
});

describe('GradingService', () => {
  describe('SINGLE_CHOICE', () => {
    const q = baseQ({
      type: QuestionType.SINGLE_CHOICE,
      options: [
        { id: 'a', label: 'A', isCorrect: false, position: 0 },
        { id: 'b', label: 'B', isCorrect: true, position: 1 },
      ],
    });
    it('full marks for correct', () => {
      expect(svc.grade(q, { payload: { selectedOptionId: 'b' } }).marksAwarded.equals(4)).toBe(true);
    });
    it('-negative for wrong', () => {
      const r = svc.grade(q, { payload: { selectedOptionId: 'a' } });
      expect(r.marksAwarded.equals(-1)).toBe(true);
      expect(r.isCorrect).toBe(false);
    });
    it('0 for unanswered', () => {
      expect(svc.grade(q, { payload: null }).marksAwarded.equals(0)).toBe(true);
    });
    it('-negative for unknown option id', () => {
      expect(svc.grade(q, { payload: { selectedOptionId: 'zzz' } }).marksAwarded.equals(-1)).toBe(true);
    });
  });

  describe('MULTIPLE_CHOICE (all-or-nothing)', () => {
    const q = baseQ({
      type: QuestionType.MULTIPLE_CHOICE,
      options: [
        { id: 'a', label: 'a', isCorrect: true, position: 0 },
        { id: 'b', label: 'b', isCorrect: true, position: 1 },
        { id: 'c', label: 'c', isCorrect: false, position: 2 },
      ],
    });
    it('full marks when all correct selected and only correct', () => {
      expect(
        svc.grade(q, { payload: { selectedOptionIds: ['a', 'b'] } }).marksAwarded.equals(4),
      ).toBe(true);
    });
    it('-negative when missing a correct one', () => {
      expect(
        svc.grade(q, { payload: { selectedOptionIds: ['a'] } }).marksAwarded.equals(-1),
      ).toBe(true);
    });
    it('-negative when an incorrect one is selected too', () => {
      expect(
        svc.grade(q, { payload: { selectedOptionIds: ['a', 'b', 'c'] } }).marksAwarded.equals(-1),
      ).toBe(true);
    });
  });

  describe('TRUE_FALSE', () => {
    const q = baseQ({ type: QuestionType.TRUE_FALSE, payload: { correct: true } });
    it('matches → full marks', () => {
      expect(svc.grade(q, { payload: { answer: true } }).isCorrect).toBe(true);
    });
    it('mismatch → -negative', () => {
      expect(svc.grade(q, { payload: { answer: false } }).marksAwarded.equals(-1)).toBe(true);
    });
  });

  describe('FILL_BLANK', () => {
    const q = baseQ({
      type: QuestionType.FILL_BLANK,
      payload: { accepted: ['Paris'], caseSensitive: false },
    });
    it('case-insensitive match → correct', () => {
      expect(svc.grade(q, { payload: { text: '  paris  ' } }).isCorrect).toBe(true);
    });
    it('wrong → -negative', () => {
      expect(svc.grade(q, { payload: { text: 'Lyon' } }).marksAwarded.equals(-1)).toBe(true);
    });
    it('case-sensitive only matches exact', () => {
      const q2 = baseQ({
        type: QuestionType.FILL_BLANK,
        payload: { accepted: ['Paris'], caseSensitive: true },
      });
      expect(svc.grade(q2, { payload: { text: 'paris' } }).isCorrect).toBe(false);
      expect(svc.grade(q2, { payload: { text: 'Paris' } }).isCorrect).toBe(true);
    });
  });

  describe('MATCH_FOLLOWING', () => {
    const q = baseQ({
      type: QuestionType.MATCH_FOLLOWING,
      payload: {
        pairs: [
          { left: 'A', right: '1' },
          { left: 'B', right: '2' },
        ],
      },
    });
    it('all correct → full marks', () => {
      expect(
        svc.grade(q, {
          payload: { matches: [{ left: 'A', right: '1' }, { left: 'B', right: '2' }] },
        }).marksAwarded.equals(4),
      ).toBe(true);
    });
    it('one wrong → -negative', () => {
      expect(
        svc.grade(q, {
          payload: { matches: [{ left: 'A', right: '2' }, { left: 'B', right: '2' }] },
        }).marksAwarded.equals(-1),
      ).toBe(true);
    });
  });

  describe('MATRIX_MATCH', () => {
    const q = baseQ({
      type: QuestionType.MATRIX_MATCH,
      payload: {
        rows: ['R1', 'R2'],
        cols: ['C1', 'C2'],
        correctMap: { R1: ['C1'], R2: ['C2'] },
      },
    });
    it('all rows correct → full marks', () => {
      expect(
        svc.grade(q, {
          payload: { selections: { R1: ['C1'], R2: ['C2'] } },
        }).isCorrect,
      ).toBe(true);
    });
    it('any row mismatch → -negative', () => {
      expect(
        svc.grade(q, {
          payload: { selections: { R1: ['C2'], R2: ['C2'] } },
        }).isCorrect,
      ).toBe(false);
    });
  });

  describe('DESCRIPTIVE', () => {
    const q = baseQ({ type: QuestionType.DESCRIPTIVE, payload: { rubric: 'rubric' } });
    it('returns null isCorrect and 0 marks (pending teacher grading)', () => {
      const r = svc.grade(q, { payload: { text: 'an answer' } });
      expect(r.isCorrect).toBeNull();
      expect(r.marksAwarded.equals(0)).toBe(true);
    });
  });
});
