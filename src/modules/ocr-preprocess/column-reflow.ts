import sharp from 'sharp';

/**
 * DISPLAY/INPUT preprocessing — column layout detection + reflow. This is a NEW layer
 * that runs on the uploaded page image BEFORE the (unchanged) OCR pipeline. It NEVER
 * imports or modifies src/shared/ocr-engine/* or the OCR use-cases.
 *
 * Purpose: a TRUE side-by-side multi-column page (independent question streams in
 * left/right columns separated by a WHITESPACE gutter) makes the existing segmenter
 * over-split into narrow slices that cut questions mid-line and drop options. Reflowing
 * such a page into one tall single-column image (each column stacked) lets the unchanged
 * pipeline crop every question at full column width.
 *
 * SAFETY: only a confidently-detected whitespace-gutter multi-column page is reflowed.
 * A page whose columns are separated by a RULED DIVIDER line (e.g. the RE NEET PST
 * baseline) is NOT detected as an empty gutter, so it stays a NO-OP — which is exactly
 * what protects already-working papers. Single-column / full-width / low-confidence →
 * NO-OP. Question quality > speed: when unsure, leave the page untouched.
 */

const INK_DARK = Number(process.env.PRE_COL_INK_DARK ?? 165);
/** A column x is "empty" if fewer than this fraction of body rows have ink there. */
const EMPTY_FRAC = Number(process.env.PRE_COL_EMPTY_FRAC ?? 0.02);
/** Reflow only at/above this confidence (spec: 0.85). */
export const REFLOW_CONFIDENCE = Number(process.env.PRE_COL_CONFIDENCE ?? 0.85);
/** HARD density floor — the evidence-based separator. A true side-by-side paper
 *  (AD 2601 Q) has DENSE columns (~0.10 ink); a sparse/divider-separated baseline that
 *  already works (RE NEET PST ~0.05) stays below this and is NEVER reflowed, even at
 *  high confidence. This is what keeps the validated 180/180 byte-identical. */
const MIN_COLUMN_INK = Number(process.env.PRE_COL_MIN_INK ?? 0.08);
/** Reflow only when the gutter is a CLEAN top-to-bottom river. If ink crosses the gutter
 *  on more than this fraction of body rows, the two sides are NOT independent question
 *  streams — it's a single question whose stem flows toward options in the other column
 *  (case #2) or wide content spanning the gutter (case #7, diagrams/tables/match/circuits/
 *  bio figures). Such a page is kept FULL-WIDTH (no-op) so the question is never split.
 *  AD's true columns cross on ~0.02–0.04 of rows, so 0.20 leaves them reflowing. */
const MAX_GUTTER_CROSSING = Number(process.env.PRE_COL_MAX_CROSS ?? 0.2);

export interface ColumnLayout {
  width: number;
  height: number;
  columns: number;
  gutterX: number | null; // centre of the main whitespace gutter (page px)
  gutterWidth: number; // px width of the empty valley
  bodyTop: number;
  bodyBottom: number;
  minColumnInk: number; // min ink density of the two columns (the density gate)
  crossingFraction: number; // fraction of body rows where ink crosses the gutter (0..1)
  confidence: number;
  reason: string;
}

/** The reflow GATE: confident, dense, two-column whitespace-gutter page. */
export const shouldReflow = (l: ColumnLayout): boolean =>
  l.columns >= 2 &&
  l.gutterX !== null &&
  l.minColumnInk >= MIN_COLUMN_INK &&
  l.crossingFraction <= MAX_GUTTER_CROSSING &&
  l.confidence >= REFLOW_CONFIDENCE;

/**
 * Detect a single central WHITESPACE gutter via a vertical ink-projection profile over
 * the body (header/footer excluded). Confidence rewards a wide, deep, EMPTY valley with
 * balanced, ink-bearing columns on both sides. A divider LINE fills the gutter with ink,
 * so it is not seen as empty ⇒ columns:1, confidence:0 (no-op). No fixed percentages.
 */
export const detectColumns = async (pageImage: Buffer): Promise<ColumnLayout> => {
  const { data, info } = await sharp(pageImage).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const bodyTop = Math.round(H * 0.12); // skip header band
  const bodyBottom = Math.round(H * 0.92); // skip footer band
  const bodyH = Math.max(1, bodyBottom - bodyTop);

  const colInk = new Float32Array(W);
  for (let y = bodyTop; y < bodyBottom; y += 1) {
    const row = y * W;
    for (let x = 0; x < W; x += 1) if (data[row + x] < INK_DARK) colInk[x] += 1;
  }
  for (let x = 0; x < W; x += 1) colInk[x] /= bodyH;

  // widest contiguous empty run in the central 30–70% band.
  const xL = Math.round(W * 0.3);
  const xR = Math.round(W * 0.7);
  let bestStart = -1;
  let bestLen = 0;
  let cur = -1;
  for (let x = xL; x <= xR; x += 1) {
    if (colInk[x] < EMPTY_FRAC) {
      if (cur < 0) cur = x;
    } else {
      if (cur >= 0 && x - cur > bestLen) {
        bestStart = cur;
        bestLen = x - cur;
      }
      cur = -1;
    }
  }
  if (cur >= 0 && xR - cur > bestLen) {
    bestStart = cur;
    bestLen = xR - cur;
  }

  const minGutter = Math.round(W * 0.015);
  if (bestStart < 0 || bestLen < minGutter) {
    return { width: W, height: H, columns: 1, gutterX: null, gutterWidth: 0, bodyTop, bodyBottom, minColumnInk: 0, crossingFraction: 0, confidence: 0, reason: 'no central whitespace gutter (single column / divider line)' };
  }

  const gutterX = Math.round(bestStart + bestLen / 2);

  // PAGE-LEVEL gutter-crossing fraction — fraction of body rows where ink falls INSIDE
  // the gutter span. A TRUE independent-stream multi-column page (AD) has a clean
  // top-to-bottom river ⇒ crossing ≈ 0. A page where one question's stem flows toward
  // its options in the other column (the "Q-left / options-right" layout, case #2) or a
  // wide diagram/table/structure spans the gutter (case #7) crosses it on many rows ⇒
  // high crossing ⇒ NOT independent columns ⇒ must NOT be stacked. This is layout-only
  // (never question numbers), so it generalizes across institutes (case #5/#6).
  let crossRows = 0;
  for (let y = bodyTop; y < bodyBottom; y += 1) {
    const row = y * W;
    for (let x = bestStart; x < bestStart + bestLen; x += 1) {
      if (data[row + x] < INK_DARK) { crossRows += 1; break; }
    }
  }
  const crossingFraction = crossRows / bodyH;

  // average ink density of each column (exclude the page's own outer margins).
  let leftSum = 0;
  let leftN = 0;
  let rightSum = 0;
  let rightN = 0;
  for (let x = Math.round(W * 0.05); x < bestStart; x += 1) { leftSum += colInk[x]; leftN += 1; }
  for (let x = bestStart + bestLen; x < Math.round(W * 0.95); x += 1) { rightSum += colInk[x]; rightN += 1; }
  const leftAvg = leftN ? leftSum / leftN : 0;
  const rightAvg = rightN ? rightSum / rightN : 0;
  const balance = Math.min(leftAvg, rightAvg) / Math.max(leftAvg, rightAvg, 1e-6); // 0..1
  const inkOk = Math.min(1, Math.min(leftAvg, rightAvg) / 0.12); // both columns carry real text
  const widthOk = Math.min(1, bestLen / (W * 0.04)); // ~4%-wide gutter → full credit
  const confidence = Math.max(0, Math.min(1, balance * 0.5 + inkOk * 0.3 + widthOk * 0.2));

  return {
    width: W,
    height: H,
    columns: 2,
    gutterX,
    gutterWidth: bestLen,
    bodyTop,
    bodyBottom,
    minColumnInk: Math.round(Math.min(leftAvg, rightAvg) * 100) / 100,
    crossingFraction: Math.round(crossingFraction * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    reason: `gutter@${gutterX} w=${bestLen} balance=${balance.toFixed(2)} inkL=${leftAvg.toFixed(2)} inkR=${rightAvg.toFixed(2)} cross=${crossingFraction.toFixed(2)}`,
  };
};

/**
 * Reflow a confident two-column page into one tall single-column image: full-width
 * bands (header/footer, or any band where content CROSSES the gutter — wide diagrams /
 * tables / match-the-following) are kept whole; two-column bands are emitted as the
 * left strip then the right strip (each left-aligned on a white W-wide canvas), so the
 * unchanged segmenter reads one column top-to-bottom with each question at full width.
 * Returns { reflowed: null } (no-op) for any page that fails the gate.
 */
export interface ReflowResult {
  reflowed: Buffer | null;
  layout: ColumnLayout;
  bands: number;
}

export const reflowPage = async (pageImage: Buffer): Promise<ReflowResult> => {
  const layout = await detectColumns(pageImage);
  if (!shouldReflow(layout) || layout.gutterX === null) {
    return { reflowed: null, layout, bands: 0 };
  }
  try {
    const { data, info } = await sharp(pageImage).greyscale().raw().toBuffer({ resolveWithObject: true });
    const W = info.width;
    const H = info.height;
    const gx = layout.gutterX;
    const pad = Math.max(4, Math.round(layout.gutterWidth * 0.3));
    const gx0 = Math.max(0, gx - pad);
    const gx1 = Math.min(W, gx + pad);

    // Per-row class: 1 = two-column (gutter empty), 0 = full-width (ink crosses gutter).
    const split = new Uint8Array(H);
    for (let y = 0; y < H; y += 1) {
      const row = y * W;
      let cross = false;
      for (let x = gx0; x < gx1 && !cross; x += 1) if (data[row + x] < INK_DARK) cross = true;
      split[y] = cross ? 0 : 1;
    }
    // Smooth: drop bands thinner than minBand (stray ink / blank line) into the run.
    const minBand = Math.max(6, Math.round(H * 0.01));
    const bands: Array<{ y0: number; y1: number; split: boolean }> = [];
    let s = 0;
    for (let y = 1; y <= H; y += 1) {
      if (y === H || split[y] !== split[s]) {
        bands.push({ y0: s, y1: y, split: split[s] === 1 });
        s = y;
      }
    }
    // merge a too-thin band into the previous (keeps big regions coherent)
    const merged: typeof bands = [];
    for (const b of bands) {
      const prev = merged[merged.length - 1];
      if (prev && b.y1 - b.y0 < minBand) prev.y1 = b.y1;
      else merged.push({ ...b });
    }

    const GAP = Math.max(8, Math.round(H * 0.012));
    const pieces: Array<{ left: number; width: number; top: number; height: number }> = [];
    for (const b of merged) {
      const h = b.y1 - b.y0;
      if (h <= 0) continue;
      if (b.split) {
        pieces.push({ left: 0, width: gx, top: b.y0, height: h }); // left column
        pieces.push({ left: gx, width: W - gx, top: b.y0, height: h }); // right column
      } else {
        pieces.push({ left: 0, width: W, top: b.y0, height: h }); // full-width band
      }
    }
    if (pieces.length === 0) return { reflowed: null, layout, bands: 0 };

    const totalH = pieces.reduce((a, p) => a + p.height, 0) + GAP * (pieces.length - 1);
    const composites: sharp.OverlayOptions[] = [];
    let yCur = 0;
    for (const p of pieces) {
      const buf = await sharp(pageImage).extract({ left: p.left, top: p.top, width: p.width, height: p.height }).toBuffer();
      composites.push({ input: buf, left: 0, top: yCur });
      yCur += p.height + GAP;
    }
    const reflowed = await sharp({ create: { width: W, height: totalH, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite(composites)
      .png()
      .toBuffer();
    return { reflowed, layout, bands: merged.length };
  } catch {
    return { reflowed: null, layout, bands: 0 }; // best-effort: never break the upload
  }
};
