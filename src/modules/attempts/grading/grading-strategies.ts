import { Decimal } from '@prisma/client/runtime/library';
import { GradingAnswer, GradingQuestion, GradingResult, IGradingStrategy } from './grading.types';

const ZERO = new Decimal(0);

const isUnanswered = (answer: GradingAnswer): boolean =>
  answer.payload === null ||
  answer.payload === undefined ||
  (typeof answer.payload === 'object' && Object.keys(answer.payload).length === 0);

const neg = (q: GradingQuestion): Decimal => q.negativeMarks.negated();

export class SingleChoiceStrategy implements IGradingStrategy {
  grade(q: GradingQuestion, a: GradingAnswer): GradingResult {
    if (isUnanswered(a)) return { isCorrect: false, marksAwarded: ZERO };
    const selectedId = a.payload?.['selectedOptionId'];
    if (typeof selectedId !== 'string') return { isCorrect: false, marksAwarded: neg(q) };
    const opt = q.options.find((o) => o.id === selectedId);
    if (!opt) return { isCorrect: false, marksAwarded: neg(q) };
    return opt.isCorrect
      ? { isCorrect: true, marksAwarded: q.marks }
      : { isCorrect: false, marksAwarded: neg(q) };
  }
}

export class TrueFalseStrategy implements IGradingStrategy {
  grade(q: GradingQuestion, a: GradingAnswer): GradingResult {
    if (isUnanswered(a)) return { isCorrect: false, marksAwarded: ZERO };
    const given = a.payload?.['answer'];
    const expected = q.payload?.['correct'];
    if (typeof given !== 'boolean' || typeof expected !== 'boolean') {
      return { isCorrect: false, marksAwarded: neg(q) };
    }
    return given === expected
      ? { isCorrect: true, marksAwarded: q.marks }
      : { isCorrect: false, marksAwarded: neg(q) };
  }
}

export class MultipleChoiceStrategy implements IGradingStrategy {
  // Phase 3 policy: all-or-nothing. Caller must select every correct option and no incorrect one.
  grade(q: GradingQuestion, a: GradingAnswer): GradingResult {
    if (isUnanswered(a)) return { isCorrect: false, marksAwarded: ZERO };
    const selected = a.payload?.['selectedOptionIds'];
    if (!Array.isArray(selected)) return { isCorrect: false, marksAwarded: neg(q) };

    const selectedSet = new Set<string>(selected.filter((s): s is string => typeof s === 'string'));
    const correctSet = new Set(q.options.filter((o) => o.isCorrect).map((o) => o.id));

    if (selectedSet.size !== correctSet.size) {
      return { isCorrect: false, marksAwarded: neg(q) };
    }
    for (const id of selectedSet) {
      if (!correctSet.has(id)) return { isCorrect: false, marksAwarded: neg(q) };
    }
    return { isCorrect: true, marksAwarded: q.marks };
  }
}

export class FillBlankStrategy implements IGradingStrategy {
  grade(q: GradingQuestion, a: GradingAnswer): GradingResult {
    if (isUnanswered(a)) return { isCorrect: false, marksAwarded: ZERO };
    const given = a.payload?.['text'];
    if (typeof given !== 'string') return { isCorrect: false, marksAwarded: neg(q) };
    const accepted = (q.payload['accepted'] as string[] | undefined) ?? [];
    const caseSensitive = q.payload['caseSensitive'] === true;
    const norm = (s: string): string => (caseSensitive ? s.trim() : s.trim().toLocaleLowerCase());
    const target = norm(given);
    const hit = accepted.some((acc) => norm(acc) === target);
    return hit
      ? { isCorrect: true, marksAwarded: q.marks }
      : { isCorrect: false, marksAwarded: neg(q) };
  }
}

export class MatchFollowingStrategy implements IGradingStrategy {
  // payload.pairs is the answer key; answer.payload.matches = [{ left, right }]
  grade(q: GradingQuestion, a: GradingAnswer): GradingResult {
    if (isUnanswered(a)) return { isCorrect: false, marksAwarded: ZERO };
    const matches = a.payload?.['matches'];
    if (!Array.isArray(matches)) return { isCorrect: false, marksAwarded: neg(q) };
    const expectedPairs =
      (q.payload['pairs'] as Array<{ left: string; right: string }> | undefined) ?? [];
    const expectedMap = new Map(expectedPairs.map((p) => [p.left, p.right]));
    if (matches.length !== expectedMap.size) {
      return { isCorrect: false, marksAwarded: neg(q) };
    }
    for (const m of matches) {
      if (
        !m ||
        typeof m !== 'object' ||
        expectedMap.get((m as Record<string, unknown>).left as string) !==
          (m as Record<string, unknown>).right
      ) {
        return { isCorrect: false, marksAwarded: neg(q) };
      }
    }
    return { isCorrect: true, marksAwarded: q.marks };
  }
}

export class MatrixMatchStrategy implements IGradingStrategy {
  // q.payload.correctMap = { row: [cols...] }; a.payload.selections = { row: [cols...] }
  grade(q: GradingQuestion, a: GradingAnswer): GradingResult {
    if (isUnanswered(a)) return { isCorrect: false, marksAwarded: ZERO };
    const selections = a.payload?.['selections'];
    if (!selections || typeof selections !== 'object')
      return { isCorrect: false, marksAwarded: neg(q) };
    const correctMap = q.payload['correctMap'] as Record<string, string[]> | undefined;
    if (!correctMap) return { isCorrect: false, marksAwarded: neg(q) };
    const rows = Object.keys(correctMap);
    if (Object.keys(selections).length !== rows.length) {
      return { isCorrect: false, marksAwarded: neg(q) };
    }
    for (const row of rows) {
      const expected = new Set(correctMap[row]);
      const givenArr = (selections as Record<string, unknown>)[row];
      if (!Array.isArray(givenArr) || givenArr.length !== expected.size) {
        return { isCorrect: false, marksAwarded: neg(q) };
      }
      for (const c of givenArr) {
        if (typeof c !== 'string' || !expected.has(c)) {
          return { isCorrect: false, marksAwarded: neg(q) };
        }
      }
    }
    return { isCorrect: true, marksAwarded: q.marks };
  }
}

export class DescriptiveStrategy implements IGradingStrategy {
  // Manual grading deferred to Phase 4; mark as pending.
  grade(_q: GradingQuestion, _a: GradingAnswer): GradingResult {
    return { isCorrect: null, marksAwarded: ZERO };
  }
}
