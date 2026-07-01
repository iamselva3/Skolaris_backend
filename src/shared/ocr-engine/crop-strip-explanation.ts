import sharp from 'sharp';

/**
 * DISPLAY-ONLY removal of a post-question EXPLANATION / SOLUTION footer block.
 *
 * Runs in the same display seam as crop-display-trim (after OCR, segmentation,
 * numbering and option detection). It only rewrites the SAVED display image bytes —
 * it never feeds OCR and never changes any draft field (questionNumber / options /
 * coordinates / count are all derived from word boxes upstream). Because it lives in
 * the display path, it physically cannot change detection: the question count and the
 * 180/180 regression are preserved by construction; the only thing at stake is whether
 * a crop is shown slightly shorter.
 *
 * Problem it solves: some papers print, AFTER a fully-answered question, an extra block —
 * a solution, explanation, answer key, hint or discussion. The segmentation crop runs to
 * the next question marker (or page bottom), so that block lands inside the question crop.
 *
 * The decision is 100% STRUCTURE / LAYOUT based — never keyword based. We do NOT look for
 * the words "Solution" / "Explanation" / "Answer" / "Hint": those are not assumed to exist
 * and are never used to find the cut. The cut is driven by:
 *   1. The question above must be COMPLETE — a question-number marker, a real stem, and a
 *      contiguous option set (A/B/C[/D]) all present.
 *   2. A genuine WHITESPACE band must separate the answer block from whatever is below it.
 *   3. The block below the band must be a TEXT block — its dark ink sits mostly inside OCR
 *      word boxes — and must NOT be options, a question marker, a ruled table, or a
 *      figure/graph/diagram (those have ink outside word boxes / long ruled lines).
 *
 * Anything ambiguous ⇒ NO-OP (return the crop untouched). Match-the-following and
 * assertion/reason question types are protected outright. Question integrity always wins:
 * we would rather keep a footer than ever clip an option / diagram / table.
 *
 * Disabled (OCR_DISPLAY_EXPLANATION_TRIM unset / != 'true') or any error ⇒ no-op.
 */

export interface ExplWBox {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ExplStripResult {
  crop: Buffer;
  /** The input word boxes minus those that fell inside the removed footer (page coords). */
  words: ExplWBox[];
}

/** Default OFF — no validated explanation-bearing sample exists in the 5 regression
 *  baselines (they are question-only), so this ships gated until validated on a real
 *  solution paper, mirroring how the other display passes were rolled out. */
export const explanationTrimEnabled = (): boolean =>
  process.env.OCR_DISPLAY_EXPLANATION_TRIM === 'true';

/** Dark-ink threshold — real ink is darker than light watermark codes. */
const CONTENT_DARK = Number(process.env.OCR_DISPLAY_EXPL_DARK ?? 150);
/** Fraction of dark ink in the footer band that must lie inside word boxes for it to
 *  count as TEXT (a figure/graph/table has ink on lines/curves outside the boxes). */
const TEXT_INK_FRAC = Number(process.env.OCR_DISPLAY_EXPL_TEXT_FRAC ?? 0.6);
/** A row/column this densely inked across the band is a ruled line ⇒ table/figure ⇒ protect. */
const RULE_FRAC = Number(process.env.OCR_DISPLAY_EXPL_RULE_FRAC ?? 0.55);
/** Minimum fraction of the crop the footer must occupy to bother cutting (else let the
 *  ordinary blank-margin/chrome trim handle it). */
const MIN_REMOVE_FRAC = Number(process.env.OCR_DISPLAY_EXPL_MIN_REMOVE ?? 0.05);

// ---- Pattern primitives (generic, never PDF-specific, never explanation-keyword based) ----
/** A lettered option label: "A." "a)" "B)" … */
const LETTER_OPTION_RE = /^([A-Da-d])[.)]$/;
/** A parenthesised option label: "(A)" "(a)" "(1)" … */
const PAREN_OPTION_RE = /^\(([A-Da-d1-4])\)$/;
/** A leading question-number marker: "12." "12)" "Q.12" "Q12". */
const QNUM_MARKER_RE = /^(?:Q\.?\s?\d{1,3}\b|\d{1,3}[.)])/i;

const isOptionLabel = (t: string): boolean => LETTER_OPTION_RE.test(t) || PAREN_OPTION_RE.test(t);

/** Normalise an option label to a comparable key, or null if not an option label. */
const optionKey = (t: string): string | null => {
  let m = LETTER_OPTION_RE.exec(t);
  if (m) return m[1].toLowerCase();
  m = PAREN_OPTION_RE.exec(t);
  if (m) return m[1].toLowerCase();
  return null;
};

/** A contiguous option set exists when the distinct labels form a run starting at the
 *  first expected label (a,b,c… or 1,2,3…) of length ≥ 3 — i.e. "all options exist". */
const optionsComplete = (labels: Set<string>): boolean => {
  const letters = [...labels].filter((l) => /[a-d]/.test(l)).sort();
  const digits = [...labels].filter((l) => /[1-4]/.test(l)).sort();
  const contiguousFrom = (vals: string[], seq: string[]): boolean => {
    if (vals.length < 3) return false;
    for (let i = 0; i < vals.length; i += 1) if (vals[i] !== seq[i]) return false;
    return true;
  };
  return (
    contiguousFrom(letters, ['a', 'b', 'c', 'd']) || contiguousFrom(digits, ['1', '2', '3', '4'])
  );
};

/** Substantive stem text above the first option label (excludes the number + labels). */
const hasStem = (words: ExplWBox[], firstOptionY: number): boolean => {
  const stem = words.filter(
    (w) =>
      w.y0 < firstOptionY - 1 &&
      !QNUM_MARKER_RE.test(w.text) &&
      !isOptionLabel(w.text) &&
      /[A-Za-z0-9]/.test(w.text),
  );
  const chars = stem.reduce((n, w) => n + w.text.length, 0);
  return stem.length >= 2 || chars >= 8;
};

/** A question-number marker exists above the option area (completion criterion). */
const hasQuestionMarker = (words: ExplWBox[], firstOptionY: number): boolean =>
  words.some((w) => w.y0 < firstOptionY && QNUM_MARKER_RE.test(w.text.trim()));

/** PROTECTED question types — never trim these (keyword guard used ONLY to be MORE
 *  conservative; it can only ever force a no-op, never trigger a removal). */
const isProtectedType = (words: ExplWBox[]): boolean => {
  const text = words
    .map((w) => w.text)
    .join(' ')
    .toLowerCase();
  if (/assertion/.test(text) && /reason/.test(text)) return true; // assertion / reason
  if (/match/.test(text) && /(column|list|following)/.test(text)) return true; // match-the-following
  return false;
};

export const stripExplanationBlock = async (
  crop: Buffer,
  opts: { words: ExplWBox[]; regionX0: number; regionY0: number },
): Promise<ExplStripResult> => {
  const noop: ExplStripResult = { crop, words: opts.words };
  if (!explanationTrimEnabled()) return noop;
  try {
    const { data, info } = await sharp(crop).greyscale().raw().toBuffer({ resolveWithObject: true });
    const W = info.width;
    const H = info.height;
    if (!W || !H) return noop;

    // Localise word boxes to crop coords; keep only those overlapping the crop.
    const words: ExplWBox[] = [];
    for (const w of opts.words) {
      const x0 = w.x0 - opts.regionX0;
      const y0 = w.y0 - opts.regionY0;
      const x1 = w.x1 - opts.regionX0;
      const y1 = w.y1 - opts.regionY0;
      if (x1 <= 0 || y1 <= 0 || x0 >= W || y0 >= H) continue;
      words.push({
        text: w.text,
        x0: Math.max(0, x0),
        y0: Math.max(0, y0),
        x1: Math.min(W - 1, x1),
        y1: Math.min(H - 1, y1),
      });
    }
    // A real completed question is at least number + stem + a few options.
    if (words.length < 6) return noop;
    if (isProtectedType(words)) return noop; // match-the-following / assertion-reason ⇒ protect

    const heights = words.map((w) => w.y1 - w.y0 + 1).sort((a, b) => a - b);
    const Hw = Math.max(6, heights[heights.length >> 1]);

    // ---- Completion check (number + stem + contiguous options) ----
    const optionWords = words.filter((w) => isOptionLabel(w.text));
    if (optionWords.length < 3) return noop;
    const labels = new Set<string>();
    for (const w of optionWords) {
      const k = optionKey(w.text);
      if (k) labels.add(k);
    }
    if (!optionsComplete(labels)) return noop; // not all options present ⇒ not complete
    const firstOptionY = Math.min(...optionWords.map((w) => w.y0));
    if (!hasStem(words, firstOptionY)) return noop;
    if (!hasQuestionMarker(words, firstOptionY)) return noop;

    // ---- Bottom of the answer block: grow down from the lowest option label through
    // vertically-contiguous words (option text wraps onto following lines). A real
    // explanation footer sits BELOW a clear whitespace gap, so it is NOT contiguous. ----
    const lowestOptionBottom = Math.max(...optionWords.map((w) => w.y1));
    let answerBottom = lowestOptionBottom;
    for (let changed = true; changed; ) {
      changed = false;
      for (const w of words) {
        if (w.y0 <= answerBottom + 1.8 * Hw && w.y1 > answerBottom) {
          answerBottom = w.y1;
          changed = true;
        }
      }
    }
    answerBottom = Math.min(H - 1, answerBottom);

    // ---- Row dark-ink density (CONTENT_DARK ignores light watermark codes). ----
    const rowDark = new Int32Array(H);
    for (let y = 0; y < H; y += 1) {
      let rc = 0;
      const base = y * W;
      for (let x = 0; x < W; x += 1) if (data[base + x] < CONTENT_DARK) rc += 1;
      rowDark[y] = rc;
    }
    const rowThresh = Math.max(3, Math.round(0.01 * W));
    // A genuine separating band — wider than ordinary inter-line leading.
    const GAP = Math.max(Math.round(1.5 * Hw), Math.round(0.04 * H));

    // Walk down from the answer block: require GAP blank rows, then find the next content.
    let blank = 0;
    let footerTop = -1;
    for (let y = answerBottom + 1; y < H; y += 1) {
      if (rowDark[y] < rowThresh) {
        blank += 1;
      } else {
        if (blank >= GAP) {
          footerTop = y;
          break;
        }
        blank = 0;
      }
    }
    if (footerTop < 0) return noop; // no whitespace-separated block below ⇒ nothing to remove

    let footerBottom = footerTop;
    for (let y = footerTop; y < H; y += 1) if (rowDark[y] >= rowThresh) footerBottom = y;

    // ---- The footer band must be a TEXT block, not options / next question / table / figure. ----
    const footerWords = words.filter((w) => {
      const cy = (w.y0 + w.y1) / 2;
      return cy >= footerTop && cy <= footerBottom;
    });
    if (footerWords.some((w) => isOptionLabel(w.text))) return noop; // an option lives below ⇒ keep
    if (footerWords.some((w) => QNUM_MARKER_RE.test(w.text.trim()))) return noop; // next question ⇒ keep
    // SUBSTANCE: a real explanation/solution block is multi-line and wordy. A single short
    // line (a page code like "CC-315", a stray mark, a lone "Answer: B") is NOT confidently an
    // explanation — leave it to the ordinary chrome trim and NO-OP here (quality > count).
    if (footerBottom - footerTop + 1 < 1.8 * Hw) return noop; // < ~2 text lines
    if (footerWords.length < 4) return noop; // too little to be an explanation block

    // Text-vs-figure: a text block's ink is mostly inside word boxes; a graph/diagram/table
    // spends ink on lines/curves OUTSIDE the boxes. Also reject any long ruled line (table).
    const bandH = footerBottom - footerTop + 1;
    let totalDark = 0;
    // A ruled line (table border / underline) is ONE long CONTIGUOUS run; dense text has
    // glyph/word gaps, so its longest run is short. Detect the run, not the total.
    const hRuleLen = Math.round(RULE_FRAC * W);
    for (let y = footerTop; y <= footerBottom; y += 1) {
      totalDark += rowDark[y];
      let run = 0;
      const base = y * W;
      for (let x = 0; x < W; x += 1) {
        if (data[base + x] < CONTENT_DARK) {
          run += 1;
          if (run >= hRuleLen) return noop; // horizontal rule ⇒ table/figure ⇒ protect
        } else run = 0;
      }
    }
    if (totalDark <= 0) return noop;
    // Vertical rule check within the band (longest contiguous vertical run).
    const vRuleLen = Math.round(RULE_FRAC * bandH);
    for (let x = 0; x < W; x += 1) {
      let run = 0;
      for (let y = footerTop; y <= footerBottom; y += 1) {
        if (data[y * W + x] < CONTENT_DARK) {
          run += 1;
          if (run >= vRuleLen) return noop; // vertical rule ⇒ table/figure ⇒ protect
        } else run = 0;
      }
    }
    // Ink coverage inside word boxes.
    const inBox = new Uint8Array(W * bandH);
    for (const w of footerWords) {
      const wy0 = Math.max(footerTop, w.y0);
      const wy1 = Math.min(footerBottom, w.y1);
      const wx0 = Math.max(0, w.x0);
      const wx1 = Math.min(W - 1, w.x1);
      for (let y = wy0; y <= wy1; y += 1)
        for (let x = wx0; x <= wx1; x += 1) inBox[(y - footerTop) * W + x] = 1;
    }
    let inkInBoxes = 0;
    for (let y = footerTop; y <= footerBottom; y += 1) {
      const base = y * W;
      const lb = (y - footerTop) * W;
      for (let x = 0; x < W; x += 1) if (data[base + x] < CONTENT_DARK && inBox[lb + x]) inkInBoxes += 1;
    }
    if (inkInBoxes / totalDark < TEXT_INK_FRAC) return noop; // figure/graph/diagram ⇒ protect

    // ---- Confidence-gated cut (bottom only; origin and left/right untouched). ----
    const PAD = Math.max(2, Math.round(0.4 * Hw));
    const cutY = Math.min(H, answerBottom + PAD);
    if (cutY <= firstOptionY) return noop; // never cut into the options
    if (cutY >= H - 2) return noop; // nothing meaningful below
    if ((H - cutY) / H < MIN_REMOVE_FRAC) return noop; // negligible ⇒ leave to chrome trim

    const out = await sharp(crop)
      .extract({ left: 0, top: 0, width: W, height: cutY })
      .png()
      .toBuffer();
    // Drop the footer words so the downstream blank-margin trim can't re-expand into them.
    const keptWords = opts.words.filter((w) => w.y0 - opts.regionY0 < cutY);
    return { crop: out, words: keptWords };
  } catch {
    return noop; // best-effort: never break or hole the saved crop
  }
};
