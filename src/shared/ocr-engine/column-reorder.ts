/*
 * Column-aware reading-order reconstruction from OCR word bounding boxes.
 *
 * Tesseract.js, when called with { blocks: true }, returns per-word bounding
 * boxes. By default tesseract emits text in horizontal-scan order (left-to-
 * right across the entire page), which on a 2-column NEET paper interleaves
 * questions from the left column with questions from the right column at the
 * same vertical band. The result is unparseable.
 *
 * This module fixes that by:
 *   1. Detecting whether a page is single-column or two-column (gap analysis
 *      over word x-centers).
 *   2. If two-column, partitioning words into Left and Right columns by the
 *      detected vertical split.
 *   3. Within each column, grouping words into lines (by y proximity), sorting
 *      lines top-to-bottom and words within each line left-to-right.
 *   4. Emitting the left column's lines first, then the right column's lines.
 *
 * Pure function: no I/O, no external state. Returns plain text PLUS the
 * detected layout label for the per-page layoutMetadata audit trail.
 */

export interface OcrWordBox {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type ReorderLayout = 'SINGLE' | 'TWO_COLUMN' | 'UNKNOWN';

export interface ReorderResult {
  text: string;
  /**
   * Priority-1 fix: per-column reading-order texts. ALWAYS populated.
   *   SINGLE / UNKNOWN → 1 entry (the whole page).
   *   TWO_COLUMN      → 2 entries [leftColumn, rightColumn].
   * The downstream parser runs INDEPENDENTLY per column so a noisy column
   * gutter can no longer interleave column-A words between column-B words.
   * Existing `text` field stays populated (columns joined with "\n\n") for
   * code paths that still want a single blob.
   */
  columns: string[];
  layout: ReorderLayout;
  /** Detected vertical split (x-coordinate) when layout=TWO_COLUMN; null otherwise. */
  splitX: number | null;
  /** Confidence of the layout decision in [0,1]. */
  confidence: number;
}

/**
 * Priority-1 fix (C2): drop words whose text appears at MULTIPLE vertically-
 * separated positions on the page — diagonal watermarks ("CC-315", "Medical")
 * and repeated stamps. Without this, watermark tokens land inside the column
 * gutter and pull adjacent text across the column split, fusing left-column
 * words with right-column words.
 *
 * Conservative thresholds:
 *   • Same lower-cased text appears ≥3 times,
 *   • AND those instances span > 100px vertically (proving they're not
 *     clustered together — a single phrase repeated by OCR mid-line stays).
 *
 * Singletons + duplicates with small Y range survive untouched, so legitimate
 * repeated content (e.g. the word "the" appearing on every line) is unaffected.
 */
export const filterRepeatedWatermarks = (words: OcrWordBox[]): OcrWordBox[] => {
  if (words.length < 30) return words; // too sparse to safely conclude anything
  const byText = new Map<string, OcrWordBox[]>();
  for (const w of words) {
    const key = (w.text || '').trim().toLowerCase();
    // Single chars and very long tokens are not watermark-shaped.
    if (key.length < 2 || key.length > 30) continue;
    const arr = byText.get(key) ?? [];
    arr.push(w);
    byText.set(key, arr);
  }
  const drop = new Set<OcrWordBox>();
  for (const instances of byText.values()) {
    if (instances.length < 3) continue;
    // X-cluster check: a TRUE watermark sits at roughly the same x position
    // across multiple y bands (it's a single stamp repeated vertically). A
    // regular vocabulary word that happens to repeat (e.g. "column"
    // appearing in both column A and column B) lands at DIFFERENT x positions
    // and must NOT be flagged — otherwise the filter eats real content.
    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const w of instances) {
      const cx = (w.x0 + w.x1) / 2;
      const cy = (w.y0 + w.y1) / 2;
      if (cx < xMin) xMin = cx;
      if (cx > xMax) xMax = cx;
      if (cy < yMin) yMin = cy;
      if (cy > yMax) yMax = cy;
    }
    // Same string spread across > 200 px horizontally → multiple genuine
    // occurrences of a common word, NOT a watermark.
    if (xMax - xMin > 200) continue;
    // Same string in < 100 px vertical span → clustered, not a watermark.
    if (yMax - yMin < 100) continue;
    for (const w of instances) drop.add(w);
  }
  if (drop.size === 0) return words;
  return words.filter((w) => !drop.has(w));
};

const xCenter = (w: OcrWordBox): number => (w.x0 + w.x1) / 2;

const meanWordHeight = (words: OcrWordBox[]): number => {
  if (words.length === 0) return 12;
  let sum = 0;
  for (const w of words) sum += w.y1 - w.y0;
  return sum / words.length;
};

/**
 * Detect a vertical column split. Returns the split x and a confidence score,
 * or null if no clear 2-column structure exists.
 *
 * Approach: bin word x-centers into a 40-bucket histogram across the page's
 * x-range; find the lowest-density bucket in the middle 30%-70% band. If that
 * minimum is < 15% of the average non-edge bucket density, treat it as the
 * column gap. Heuristic but robust for ERP-style 2-column papers.
 */
const detectColumnSplit = (words: OcrWordBox[]): { splitX: number; confidence: number } | null => {
  if (words.length < 30) return null; // too sparse to detect
  const xs = words.map(xCenter).sort((a, b) => a - b);
  const xMin = xs[0];
  const xMax = xs[xs.length - 1];
  const width = xMax - xMin;
  if (width <= 0) return null;

  const BUCKETS = 40;
  const buckets = new Array(BUCKETS).fill(0);
  for (const x of xs) {
    const idx = Math.min(BUCKETS - 1, Math.max(0, Math.floor(((x - xMin) / width) * BUCKETS)));
    buckets[idx] += 1;
  }

  // Average density over the "non-edge" middle (skip first/last 4 buckets).
  let nonEdgeSum = 0;
  let nonEdgeN = 0;
  for (let i = 4; i < BUCKETS - 4; i += 1) {
    nonEdgeSum += buckets[i];
    nonEdgeN += 1;
  }
  const avgNonEdge = nonEdgeN > 0 ? nonEdgeSum / nonEdgeN : 0;
  if (avgNonEdge <= 0) return null;

  // Search the middle 30-70% band for the lowest-density bucket — the column gutter.
  const bandStart = Math.floor(BUCKETS * 0.3);
  const bandEnd = Math.ceil(BUCKETS * 0.7);
  let minBucket = bandStart;
  let minVal = buckets[bandStart];
  for (let i = bandStart + 1; i < bandEnd; i += 1) {
    if (buckets[i] < minVal) {
      minVal = buckets[i];
      minBucket = i;
    }
  }

  // Gap must be substantially emptier than the average non-edge density.
  const ratio = minVal / avgNonEdge;
  if (ratio > 0.18) return null;

  const splitX = xMin + ((minBucket + 0.5) / BUCKETS) * width;
  // Confidence rises as the gap deepens (lower ratio → higher confidence).
  const confidence = Math.min(0.98, 0.6 + (0.18 - ratio) * 2);
  return { splitX, confidence };
};

const sortIntoLines = (words: OcrWordBox[]): OcrWordBox[][] => {
  if (words.length === 0) return [];
  const sorted = [...words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lineThreshold = meanWordHeight(sorted) * 0.7;

  const lines: OcrWordBox[][] = [];
  let current: OcrWordBox[] = [sorted[0]];
  let currentBaseline = sorted[0].y0;

  for (let i = 1; i < sorted.length; i += 1) {
    const w = sorted[i];
    if (Math.abs(w.y0 - currentBaseline) <= lineThreshold) {
      current.push(w);
    } else {
      current.sort((a, b) => a.x0 - b.x0);
      lines.push(current);
      current = [w];
      currentBaseline = w.y0;
    }
  }
  current.sort((a, b) => a.x0 - b.x0);
  lines.push(current);
  return lines;
};

const linesToText = (lines: OcrWordBox[][]): string =>
  lines
    .map((ln) =>
      ln
        .map((w) => w.text)
        .join(' ')
        .trim(),
    )
    .filter((s) => s.length > 0)
    .join('\n');

/**
 * Main entry. Given a page's OCR'd words (with bboxes), produce reading-order
 * text by detecting and respecting column structure.
 */
export const reorderByColumns = (words: OcrWordBox[]): ReorderResult => {
  // Filter out empty/whitespace-only words; tesseract sometimes emits them.
  // Then strip diagonal/repeated watermark tokens that would pollute the
  // column-gutter histogram + drag text across the split (Priority-1 / C2).
  const nonEmpty = words.filter((w) => w.text && w.text.trim().length > 0);
  const clean = filterRepeatedWatermarks(nonEmpty);
  if (clean.length < 10) {
    const text = linesToText(sortIntoLines(clean));
    return {
      text,
      columns: [text],
      layout: 'UNKNOWN',
      splitX: null,
      confidence: 0.5,
    };
  }

  // First try the histogram-gap detector. If it fails (which happens when a
  // page has a full-width header eating the middle band — common on page 1 of
  // exam papers), fall back to a midpoint split and let the minorityRatio
  // safety net below revert genuinely-single-column pages. This biases us
  // toward "treat as 2-column" — which is the right default for coaching
  // papers and self-correcting for true single-column.
  let split = detectColumnSplit(clean);
  let usedFallback = false;
  if (!split) {
    const xs = clean.map(xCenter).sort((a, b) => a - b);
    const midpoint = (xs[0] + xs[xs.length - 1]) / 2;
    split = { splitX: midpoint, confidence: 0.55 };
    usedFallback = true;
  }

  // Partition into left / right columns by the detected (or fallback) split.
  // Words straddling the split go to whichever side their CENTER lies in.
  const left: OcrWordBox[] = [];
  const right: OcrWordBox[] = [];
  for (const w of clean) {
    if (xCenter(w) < split.splitX) left.push(w);
    else right.push(w);
  }

  // If one side has <15% of the words, the page is functionally single-column
  // (the "minority" is probably a stray diagram label, a page number, or text
  // bleed near the gutter). Read sequentially in that case.
  const minorityRatio = Math.min(left.length, right.length) / clean.length;
  if (minorityRatio < 0.15) {
    const text = linesToText(sortIntoLines(clean));
    return {
      text,
      columns: [text],
      layout: 'SINGLE',
      splitX: null,
      confidence: usedFallback ? 0.7 : 0.65,
    };
  }

  const leftLines = sortIntoLines(left);
  const rightLines = sortIntoLines(right);
  const leftText = linesToText(leftLines);
  const rightText = linesToText(rightLines);
  return {
    // Joined `text` kept for code paths that still take a single blob — same
    // shape as before so legacy consumers don't regress.
    text: `${leftText}\n${rightText}`,
    // Per-column array is the canonical Priority-1 output: downstream parsing
    // runs INDEPENDENTLY per column, eliminating left/right word interleave.
    columns: [leftText, rightText],
    layout: 'TWO_COLUMN',
    splitX: split.splitX,
    confidence: usedFallback ? 0.65 : split.confidence,
  };
};
