import { classifyAnswerKeyPage, selectAnswerKeyPages } from './answer-key-ocr';

// A dense answer-grid page (many "N X" rows, little prose).
const KEY_PAGE = Array.from({ length: 20 }, (_, i) => `${i + 1}. ${'ABCD'[i % 4]}`).join('\n');
// A worked-solution page (prose + solution cues, sparse answer rows).
const SOLUTION_PAGE =
  'Solution 1: We have the equation. Substituting the values, hence the result. ' +
  'Therefore the correct option is derived as shown in the figure. ' +
  'Explanation continues with several detailed steps and reasoning across the page.';

describe('classifyAnswerKeyPage', () => {
  it('classifies a dense answer grid as ANSWER_KEY', () => {
    const c = classifyAnswerKeyPage(1, KEY_PAGE);
    expect(c.type).toBe('ANSWER_KEY');
    expect(c.answerPairs).toBeGreaterThanOrEqual(15);
  });

  it('classifies a worked-solution page as SOLUTION', () => {
    const c = classifyAnswerKeyPage(2, SOLUTION_PAGE);
    expect(c.type).toBe('SOLUTION');
  });
});

describe('selectAnswerKeyPages', () => {
  it('keeps answer-key pages and ignores the solutions section that follows', () => {
    const sel = selectAnswerKeyPages([KEY_PAGE, KEY_PAGE, SOLUTION_PAGE, SOLUTION_PAGE]);
    expect(sel.used).toEqual([1, 2]);
    expect(sel.ignored.map((x) => x.page)).toEqual([3, 4]);
    expect(sel.ignored[0].reason).toMatch(/solution/i);
  });

  it('falls back to any page with answers rather than dropping a small key', () => {
    const sel = selectAnswerKeyPages(['1-A 2-B 3-C']); // single small key, low density
    expect(sel.used).toEqual([1]);
  });

  it('ignores a pure prose/diagram page with no answers', () => {
    const sel = selectAnswerKeyPages(['A diagram of a circuit with labels and a caption only.']);
    expect(sel.used).toEqual([]);
    expect(sel.ignored[0].reason).toMatch(/no answer mappings/i);
  });
});
