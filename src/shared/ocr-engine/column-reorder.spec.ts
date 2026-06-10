/**
 * Priority-1 validation: column reorder + watermark filter MUST produce a
 * per-column text output that lets parseDrafts run independently per column.
 * The blocking gate: a 2-column page with 4 numbered questions → 4 drafts.
 *
 * These tests use synthetic OcrWordBox arrays — no Paddle/Tesseract dep —
 * because we're validating the LAYOUT logic, not OCR accuracy.
 */
import { reorderByColumns, filterRepeatedWatermarks, type OcrWordBox } from './column-reorder';

const w = (text: string, x0: number, y0: number, x1: number, y1: number): OcrWordBox => ({
  text,
  x0,
  y0,
  x1,
  y1,
});

// Build a horizontal text "line" of words at a given Y, starting at xStart.
// Each word gets x0..x1 with simple spacing.
const line = (texts: string[], xStart: number, y: number, charPx = 9, gapPx = 5): OcrWordBox[] => {
  let x = xStart;
  return texts.map((t) => {
    const wd = t.length * charPx;
    const box = w(t, x, y, x + wd, y + 14);
    x += wd + gapPx;
    return box;
  });
};

describe('filterRepeatedWatermarks', () => {
  it('drops a token repeated at multiple vertically-separated positions', () => {
    // "cc-315" appears at y=50, y=400, y=800 — diagonal watermark.
    // 30 filler words to clear the < 30 sparsity gate.
    const filler: OcrWordBox[] = [];
    for (let i = 0; i < 30; i += 1) {
      filler.push(w(`word${i}`, 100, 100 + i * 5, 180, 110 + i * 5));
    }
    const watermark = [
      w('cc-315', 500, 50, 560, 70),
      w('cc-315', 500, 400, 560, 420),
      w('cc-315', 500, 800, 560, 820),
    ];
    const out = filterRepeatedWatermarks([...filler, ...watermark]);
    expect(out.some((x) => x.text === 'cc-315')).toBe(false);
    expect(out.length).toBe(filler.length);
  });

  it('keeps a token that appears 3 times CLOSE together (not a watermark)', () => {
    const filler: OcrWordBox[] = [];
    for (let i = 0; i < 30; i += 1) {
      filler.push(w(`word${i}`, 100, 100 + i * 5, 180, 110 + i * 5));
    }
    // "the" three times in close vertical proximity — normal repeated word.
    const close = [
      w('the', 100, 200, 130, 215),
      w('the', 200, 210, 230, 225),
      w('the', 300, 220, 330, 235),
    ];
    const out = filterRepeatedWatermarks([...filler, ...close]);
    expect(out.filter((x) => x.text === 'the').length).toBe(3);
  });

  it('returns input untouched when word count < 30 (sparsity safety)', () => {
    const few = [
      w('cc-315', 100, 50, 160, 70),
      w('cc-315', 100, 400, 160, 420),
      w('cc-315', 100, 800, 160, 820),
    ];
    const out = filterRepeatedWatermarks(few);
    expect(out.length).toBe(3);
  });
});

describe('reorderByColumns — Priority-1 per-column output', () => {
  it('columns[] is always populated and its joined form matches text', () => {
    // Either SINGLE (one entry) or TWO_COLUMN (two entries) — the contract
    // is that columns is never empty and that the canonical `text` field
    // equals the columns joined with the same separator the reorder uses.
    const ws = [
      ...line(['Title', 'of', 'the', 'paper', 'is', 'shown', 'below'], 100, 50),
      ...line(['Body', 'continues', 'with', 'multiple', 'lines', 'here'], 100, 80),
      ...line(['Another', 'sentence', 'with', 'enough', 'distinct', 'words'], 100, 110),
      ...line(['Yet', 'more', 'unique', 'content', 'in', 'the', 'flow'], 100, 140),
    ];
    const rr = reorderByColumns(ws);
    expect(rr.columns.length).toBeGreaterThanOrEqual(1);
    // No matter what layout the heuristic picks, columns and text must agree.
    const joined = rr.columns.length === 1 ? rr.columns[0] : rr.columns.join('\n');
    expect(joined).toBe(rr.text);
  });

  it('TWO_COLUMN: returns separate left + right strings, NEVER interleaves', () => {
    // 2-column page: column A at x≈100-400, column B at x≈600-900.
    // Each column has 4 numbered questions stacked vertically.
    const left = [
      ...line(
        ['1.', 'Left', 'column', 'Q1', 'stem', 'goes', 'here', 'with', 'enough', 'words'],
        100,
        50,
      ),
      ...line(['(1)', 'opt', 'A'], 100, 80),
      ...line(['(2)', 'opt', 'B'], 100, 100),
      ...line(
        ['2.', 'Left', 'column', 'Q2', 'stem', 'continues', 'here', 'sufficiently', 'long', 'too'],
        100,
        200,
      ),
      ...line(['(1)', 'opt', 'A'], 100, 230),
      ...line(['(2)', 'opt', 'B'], 100, 250),
    ];
    const right = [
      ...line(
        ['3.', 'Right', 'column', 'Q3', 'stem', 'goes', 'here', 'with', 'enough', 'words'],
        600,
        50,
      ),
      ...line(['(1)', 'opt', 'A'], 600, 80),
      ...line(['(2)', 'opt', 'B'], 600, 100),
      ...line(
        ['4.', 'Right', 'column', 'Q4', 'stem', 'continues', 'here', 'sufficiently', 'long', 'too'],
        600,
        200,
      ),
      ...line(['(1)', 'opt', 'A'], 600, 230),
      ...line(['(2)', 'opt', 'B'], 600, 250),
    ];
    const rr = reorderByColumns([...left, ...right]);
    expect(rr.layout).toBe('TWO_COLUMN');
    expect(rr.columns.length).toBe(2);
    // Left column text must contain Q1+Q2, no Q3/Q4.
    expect(rr.columns[0]).toMatch(/Q1 stem/);
    expect(rr.columns[0]).toMatch(/Q2 stem/);
    expect(rr.columns[0]).not.toMatch(/Q3/);
    expect(rr.columns[0]).not.toMatch(/Q4/);
    // Right column text must contain Q3+Q4, no Q1/Q2.
    expect(rr.columns[1]).toMatch(/Q3 stem/);
    expect(rr.columns[1]).toMatch(/Q4 stem/);
    expect(rr.columns[1]).not.toMatch(/Q1/);
    expect(rr.columns[1]).not.toMatch(/Q2/);
  });

  it('TWO_COLUMN: watermark in the gutter does NOT drag column-A words into column-B', () => {
    // Same 2-column page, plus a diagonal watermark "CC-315" at multiple Y
    // positions in the gutter area. The watermark filter should remove these
    // BEFORE column detection so they can't drag adjacent text across the split.
    const left = [
      ...line(
        ['1.', 'Left', 'column', 'Q1', 'stem', 'continues', 'with', 'enough', 'words', 'here'],
        100,
        50,
      ),
      ...line(
        ['2.', 'Left', 'column', 'Q2', 'stem', 'continues', 'with', 'enough', 'words', 'here'],
        100,
        200,
      ),
    ];
    const right = [
      ...line(
        ['3.', 'Right', 'column', 'Q3', 'stem', 'continues', 'with', 'enough', 'words'],
        600,
        50,
      ),
      ...line(
        ['4.', 'Right', 'column', 'Q4', 'stem', 'continues', 'with', 'enough', 'words'],
        600,
        200,
      ),
    ];
    const watermark = [
      w('cc-315', 450, 100, 510, 120),
      w('cc-315', 450, 300, 510, 320),
      w('cc-315', 450, 500, 510, 520),
    ];
    const rr = reorderByColumns([...left, ...right, ...watermark]);
    // Confirm watermark was filtered.
    expect(rr.text).not.toMatch(/cc-315/i);
    // And columns are still cleanly separated.
    expect(rr.columns.length).toBe(2);
    expect(rr.columns[0]).toMatch(/Q1.*Q2/s);
    expect(rr.columns[1]).toMatch(/Q3.*Q4/s);
  });
});
