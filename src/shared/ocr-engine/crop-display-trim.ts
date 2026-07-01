import sharp from 'sharp';
import { explanationTrimEnabled, stripExplanationBlock } from './crop-strip-explanation';

/**
 * DISPLAY-ONLY second-stage trim of the question crop. Runs AFTER OCR, segmentation,
 * numbering and option detection — it only rewrites the SAVED display image bytes and
 * never feeds OCR or changes any draft field (questionNumber/options/coordinates are
 * all derived from word boxes upstream). The OCR crop coordinates are unchanged.
 *
 * Problem it solves: the segmentation crop region runs to the next-question / page
 * boundary, so a short question leaves 50–80% blank, and the bottom of that blank band
 * contains TRAILING CHROME — the page-footer separator rule, the page number, the
 * CC-315 / C-315 watermark codes, and the full-height column-divider line. A naive
 * "bounding box of any dark pixel" is dragged to the bottom by that chrome and trims
 * almost nothing.
 *
 * Approach (content-DENSITY block, anchored by OCR word boxes):
 *   1. Find the dense content block from the top using DARK-ink density (a threshold
 *      below the light CC-315 grey, so the codes are ignored). Walk down and stop at a
 *      blank run larger than BLOCK_GAP — the big band before the footer. The separator
 *      rule + page number sit AFTER that gap and are excluded; a diagram has no such
 *      internal gap so it stays.
 *   2. GROW the block through nearby word boxes so options (which density may miss when
 *      a blank line precedes them) are never clipped; a far-below footer word is left out.
 *   3. CONTAIN every in-block word box (question text + options) — a hard guarantee that
 *      no text/option is clipped.
 *   4. For columns, exclude isolated full-height divider lines, then contain the words.
 *   5. CONFIDENCE FALLBACK — if there is substantial dark ink below the gap (could be a
 *      diagram, not footer), or there is nothing to anchor, or the result is implausibly
 *      small or already fills the crop, keep the ORIGINAL crop. Never crop aggressively.
 *
 * Disabled (OCR_DISPLAY_CROP_TRIM=false) or any error ⇒ returns the original buffer.
 */
export const displayCropTrimEnabled = (): boolean =>
  process.env.OCR_DISPLAY_CROP_TRIM !== 'false';

/** Dark-ink threshold. Real ink (text/diagram/table rules) is darker than the light
 *  CC-315 watermark codes, so a cutoff here ignores the codes during block detection. */
const CONTENT_DARK = Number(process.env.OCR_DISPLAY_TRIM_DARK ?? 150);
/** Safety padding kept around the detected content on all four sides (crop px). A small margin so a
 *  question is never visually clipped (hybrid architecture safety-margin rule, 2026-06-24: "+20px"). */
const PAD = Math.max(0, Math.round(Number(process.env.OCR_DISPLAY_TRIM_PAD ?? 20)));
/** If the content already fills at least this fraction of the crop, don't trim. */
const SKIP_IF_FILLED = Number(process.env.OCR_DISPLAY_TRIM_SKIP_FILLED ?? 0.9);

interface WBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Display-only crop tidy-up, in two additive stages — each independently gated and each a
 * safe no-op when uncertain:
 *   1. stripExplanationBlock — remove a whitespace-separated explanation/solution footer
 *      that sits below a COMPLETE question (structure-based; OCR_DISPLAY_EXPLANATION_TRIM).
 *   2. trimBlankMargins — trim surrounding blank margins + trailing page chrome
 *      (OCR_DISPLAY_CROP_TRIM, the original validated pass, unchanged below).
 * Neither stage touches any draft field; both only rewrite the saved crop bytes.
 */
export const trimDisplayCrop = async (
  crop: Buffer,
  opts: {
    words: WBox[];
    regionX0: number;
    regionY0: number;
    /** Page-Y of the top of this question's printed number marker, when one was
     *  detected. The header trim uses it as the safe top-of-question anchor; absent
     *  (no clean marker) ⇒ the header trim is a NO-OP. Display-only, value-free. */
    markerTopY?: number;
    /** When OCR_CROP_TRACE is set, label these per-stage dimension logs (e.g. the question number). */
    traceLabel?: string | number;
  },
): Promise<Buffer> => {
  let workingCrop = crop;
  let workingWords = opts.words;
  let regionY0 = opts.regionY0;
  const trace = process.env.OCR_CROP_TRACE ? async (stage: string, buf: Buffer) => {
    const m = await sharp(buf).metadata();
    // eslint-disable-next-line no-console
    console.error(`[CROPTRACE] q=${opts.traceLabel ?? '?'} ${stage} ${m.width}x${m.height}`);
  } : null;
  if (trace) await trace('0-input    ', workingCrop);
  // STAGE 0 — header / running-title / top-banner / top-logo trim (top-side mirror of the
  // trailing-chrome trim). Cuts page chrome sitting ABOVE the question marker; shifts
  // regionY0 down by the removed height so the word-box maths in the later stages stay aligned.
  if (headerTrimEnabled() && opts.markerTopY != null) {
    const h = await trimHeaderBand(workingCrop, { markerTopY: opts.markerTopY, regionY0 });
    workingCrop = h.crop;
    regionY0 = h.regionY0;
  }
  if (trace) await trace('1-header   ', workingCrop);
  if (explanationTrimEnabled()) {
    const stripped = await stripExplanationBlock(workingCrop, {
      words: workingWords.map((w) => ({ ...w, text: (w as { text?: string }).text ?? '' })),
      regionX0: opts.regionX0,
      regionY0,
    });
    workingCrop = stripped.crop;
    workingWords = stripped.words as WBox[];
  }
  if (trace) await trace('2-explan   ', workingCrop);
  // STAGE 1.5 — DEDICATED FOOTER-BAND removal. The generic margin trim below conservatively KEEPS a
  // multi-line institute footer (it can't tell a 3–5 line footer from a diagram). This proves the
  // bottom band is page chrome (phone / website / address) below a divider-or-gap and cuts only it.
  if (footerTrimEnabled()) {
    workingCrop = await trimFooterBand(workingCrop, { words: workingWords, regionX0: opts.regionX0, regionY0 });
  }
  if (trace) await trace('3-footer   ', workingCrop);
  const final = await trimBlankMargins(workingCrop, { words: workingWords, regionX0: opts.regionX0, regionY0 });
  if (trace) await trace('4-margins  ', final);
  return final;
};

/**
 * DISPLAY-ONLY dedicated footer-band trim. Removes the page footer (institute address / phone /
 * website / helpline) that sits in the BOTTOM band, below the question content, separated by a
 * horizontal divider OR a whitespace gap. PROOF-gated and content-safe by construction:
 *   1. footer chrome (phone / website / ≥2 ALL-CAPS address words) must appear in the bottom band;
 *   2. the cut is placed just BELOW the last NON-chrome (content) word — a content word is never
 *      clipped (0 content loss); 3. the separator zone above the footer must be blank or a divider
 *      (a diagram in that gap ⇒ keep). Generic: pattern-based, no institute/PDF/subject literals.
 * Disabled with OCR_DISPLAY_FOOTER_TRIM=false. Any error / not proven ⇒ no-op.
 */
export const footerTrimEnabled = (): boolean =>
  process.env.OCR_DISPLAY_FOOTER_TRIM !== 'false';

// STRICT per-word phone token — a long digit run or a "+country" prefix. Deliberately does NOT match
// a 2–3 digit MCQ option value ("25", "30"), so a numeric option block is never mistaken for a phone.
const PHONE_WORD = /^\+\d{2,}$|^\d{5,}$|^\+?\d[\d().-]{7,}\d$/;
// NB: NO bare "@" — OCR garbles option markers "(a)/(b)/(c)/(d)" into "@"/"(©", which would
// misclassify an option line as a footer and clip the options. A real email footer still matches its
// domain (.com/.in/…); the website signal alone is reliable and never appears in an option block.
const WEB_RE = /(www\.|https?:\/\/|\.com\b|\.in\b|\.org\b|\.edu\b|\.net\b)/i;
const ADDR_RE = /^[A-Z][A-Z.&-]{3,}[,.]?$/; // an ALL-CAPS place / institute word: "MADURAI," "TAMILNADU"
// Option label ANYWHERE in a line's text — catches glued OCR tokens like "(b)040", "b)ZC", "(d)0.75".
// A line carrying any of these is an OPTION line, never a footer ⇒ it breaks the footer run (0-loss).
const OPT_IN_LINE = /\(?[A-Da-d]\)|\([1-9]\)/;

interface FWord { x0: number; y0: number; x1: number; y1: number; text: string }

/**
 * Shared footer detector. Given LOCALISED word boxes (origin already subtracted) + the greyscale
 * raster of the SAME image (W×H), returns the Y at which to cut/whiten so the bottom institute footer
 * (phone / website / ALL-CAPS address) is removed — or -1 when no footer is proven. 0-loss: the cut is
 * always just BELOW the last NON-footer (content/option) line, so no content line is ever touched.
 */
const detectFooterCutY = (words: FWord[], data: Buffer, W: number, H: number): number => {
  const valid = words
    .filter((w) => w.y1 > 0 && w.y0 < H && w.x1 > 0 && w.x0 < W && (w.text ?? '').trim().length > 0)
    .map((w) => ({ ...w, text: w.text.trim() }))
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  if (valid.length === 0) return -1;
  const hs = valid.map((w) => w.y1 - w.y0).filter((h) => h > 0).sort((a, b) => a - b);
  const Hw = Math.max(8, hs[hs.length >> 1] || 12);

  interface Line { y0: number; y1: number; ws: FWord[]; text: string }
  const lines: Line[] = [];
  for (const w of valid) {
    const last = lines[lines.length - 1];
    if (last && w.y0 <= last.y1 + Hw * 0.5) { last.ws.push(w); last.y0 = Math.min(last.y0, w.y0); last.y1 = Math.max(last.y1, w.y1); }
    else lines.push({ y0: w.y0, y1: w.y1, ws: [w], text: '' });
  }
  for (const l of lines) l.text = l.ws.map((w) => w.text).join(' ');

  const lowerCount = (t: string): number => t.match(/[a-z]/g)?.length ?? 0;
  // A QUESTION-CONTENT line carries an option label, an option value (digit-punct-digit like "1) 25",
  // "3:2", "0.48"), lowercase prose, or a "?" — and is NOT a website line. EVERYTHING else at the page
  // bottom (institute logo / banner / address / phone / website / helpline / separators, including a
  // GARBLED stylised logo like "THE SK LEARNINGS®") is FOOTER. This makes the footer ONE object: a
  // garbled logo line no longer breaks the run, so the whole footer is removed — never a partial trail.
  // A standalone option-label token: "4)", "(1)", "a)", "5." — catches numeric/scientific options
  // ("4) 40×10⁻³") that the inline digit-value pattern misses when OCR inserts a space or an "×".
  const OPT_LABEL_WORD = /^\(?[1-9A-Da-d][).]$/;
  const isContentLine = (l: Line): boolean => {
    if (WEB_RE.test(l.text)) return false; // a website line is footer, never content
    return OPT_IN_LINE.test(l.text)
      || l.ws.some((wd) => OPT_LABEL_WORD.test(wd.text))
      || /\d\s*[).:]\s*\d/.test(l.text)
      || lowerCount(l.text) > 6
      || /\?/.test(l.text);
  };
  const isAnchor = (l: Line): boolean =>
    l.ws.some((w) => PHONE_WORD.test(w.text)) || WEB_RE.test(l.text) || l.ws.filter((w) => ADDR_RE.test(w.text)).length >= 2;

  // Walk UP from the bottom while the line is NOT question content — the contiguous non-content block.
  let i = lines.length - 1;
  const block: Line[] = [];
  while (i >= 0 && !isContentLine(lines[i])) { block.unshift(lines[i]); i -= 1; }
  if (block.length === 0) return -1; // bottom line is question content ⇒ no footer

  // SPLIT AT THE LARGEST WHITESPACE GAP. The page footer is separated from the question block by the
  // page-margin gap; a garbled option mis-read as non-content (e.g. "4) 40×10⁷" → "40x107") sits in
  // the OPTION block, only a normal line-gap from the other options. So the TRUE footer is the part of
  // the block BELOW the biggest gap (≥ ~1 line). Lines above that gap stay with the content (0-loss),
  // matching the rule "footer = separated by a divider OR a large whitespace gap".
  const seq: Line[] = (i >= 0 ? [lines[i]] : []).concat(block); // content boundary (if any) + block, top→bottom
  let bestGap = -1;
  let bestIdx = -1; // footer begins at seq[bestIdx]
  for (let k = 1; k < seq.length; k += 1) { const gap = seq[k].y0 - seq[k - 1].y1; if (gap > bestGap) { bestGap = gap; bestIdx = k; } }
  const MIN_GAP = Math.max(10, Math.round(1.0 * Hw));
  if (bestIdx < 1 || bestGap < MIN_GAP) return -1; // no clear question→footer separation ⇒ keep
  const footer = seq.slice(bestIdx);
  if (!footer.some(isAnchor)) return -1; // the separated bottom block must be a proven footer

  const footerTop = footer[0].y0;
  if (footerTop < 0.45 * H) return -1; // footer must sit in the BOTTOM band
  // Cut just below the last line ABOVE the gap ⇒ no option / question / caption line is ever clipped.
  const cutY = Math.min(H - 1, seq[bestIdx - 1].y1 + Math.round(0.4 * Hw));
  if (cutY < Math.round(0.25 * H)) return -1;

  // DIAGRAM GUARD: a footer is THIN text (sparse ink). If the band [cutY,H] is ink-dense it is a
  // figure/table, not a footer ⇒ keep the crop. This is what protects a diagram sitting low on the page.
  let dark = 0;
  for (let y = cutY; y < H; y += 1) { const base = y * W; for (let x = 0; x < W; x += 1) if (data[base + x] < CONTENT_DARK) dark += 1; }
  if (dark / Math.max(1, W * (H - cutY)) > 0.3) return -1; // dense ⇒ likely a diagram/table ⇒ keep
  return cutY;
};

const trimFooterBand = async (
  crop: Buffer,
  opts: { words: WBox[]; regionX0: number; regionY0: number },
): Promise<Buffer> => {
  try {
    const { data, info } = await sharp(crop).greyscale().raw().toBuffer({ resolveWithObject: true });
    const W = info.width;
    const H = info.height;
    if (!W || !H) return crop;
    const local: FWord[] = opts.words.map((w) => ({ x0: w.x0 - opts.regionX0, y0: w.y0 - opts.regionY0, x1: w.x1 - opts.regionX0, y1: w.y1 - opts.regionY0, text: (w as { text?: string }).text ?? '' }));
    const cutY = detectFooterCutY(local, data, W, H);
    if (cutY < 0) return crop;
    return await sharp(crop).extract({ left: 0, top: 0, width: W, height: cutY }).png().toBuffer();
  } catch {
    return crop;
  }
};

/**
 * PAGE-LEVEL footer removal (the real fix): WHITEN the bottom institute footer on the PAGE before any
 * crop or cross-page stitch is taken. Without this, a cross-page question stitched across the page
 * boundary drags the page footer into the MIDDLE of the crop (which a crop-bottom trim cannot reach),
 * and the footer also corrupts cross-page question merging. Whitening on the page erases it everywhere
 * at once. Content-safe: same proof + the cut is below the last content line; only [cutY,H] is whitened.
 * Words are page-image coords (origin 0,0). Disabled with OCR_DISPLAY_FOOTER_TRIM=false.
 */
export const whitenFooterBand = async (
  page: Buffer,
  words: ReadonlyArray<{ x0: number; y0: number; x1: number; y1: number; text?: string }>,
): Promise<Buffer> => {
  if (!footerTrimEnabled() || words.length === 0) return page;
  try {
    const { data, info } = await sharp(page).greyscale().raw().toBuffer({ resolveWithObject: true });
    const W = info.width;
    const H = info.height;
    if (!W || !H) return page;
    const local: FWord[] = words.map((w) => ({ x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, text: w.text ?? '' }));
    const cutY = detectFooterCutY(local, data, W, H);
    if (cutY < 0) return page;
    return await sharp(page)
      .composite([{ input: { create: { width: W, height: H - cutY, channels: 3, background: { r: 255, g: 255, b: 255 } } }, left: 0, top: cutY }])
      .png()
      .toBuffer();
  } catch {
    return page;
  }
};

/**
 * DISPLAY-ONLY header / running-title / institute-banner / top-logo trim.
 *
 * Grammar anchor (value-free, generic): a logical question can NEVER begin above its
 * own printed question number. So any ink band that sits ABOVE the question marker AND
 * is separated from it by a real whitespace gap is page chrome — a running header, an
 * institute banner, a top logo or a course-code strip — never question content. We crop
 * it off the SHOWN image only. The marker carries no semantic meaning here beyond "the
 * question starts here"; nothing keys on the number's value, the institute, or the page.
 *
 * Conservative by construction — returns the crop UNCHANGED when:
 *   • the header trim is disabled, or no marker was detected (`markerTopY` absent);
 *   • the marker is already at the very top (nothing above it);
 *   • the band touches the marker (no clean whitespace gap ⇒ same block ⇒ keep);
 *   • there is only blank margin above (left to `trimBlankMargins`);
 *   • the cut would leave an implausibly small crop.
 * Disabled with OCR_DISPLAY_HEADER_TRIM=false. Any error ⇒ no-op.
 */
export const headerTrimEnabled = (): boolean =>
  process.env.OCR_DISPLAY_HEADER_TRIM !== 'false';

const trimHeaderBand = async (
  crop: Buffer,
  opts: { markerTopY: number; regionY0: number },
): Promise<{ crop: Buffer; regionY0: number }> => {
  const noop = { crop, regionY0: opts.regionY0 };
  try {
    const { data, info } = await sharp(crop).greyscale().raw().toBuffer({ resolveWithObject: true });
    const W = info.width;
    const H = info.height;
    if (!W || !H) return noop;

    // Marker top in crop coordinates. At/above the crop top ⇒ nothing above ⇒ no-op.
    const markerTop = Math.round(opts.markerTopY - opts.regionY0);
    if (markerTop <= 0 || markerTop >= H) return noop;

    // Row dark-ink density (same CONTENT_DARK cutoff as the trailing trim — ignores the
    // light CC-315 codes). A row is "inked" when it carries more than a stray-pixel amount.
    const rowThresh = Math.max(3, Math.round(0.01 * W));
    const rowDark = (y: number): number => {
      let c = 0;
      const base = y * W;
      for (let x = 0; x < W; x += 1) if (data[base + x] < CONTENT_DARK) c += 1;
      return c;
    };

    // A real whitespace gap must separate the band from the marker. Sized relative to the
    // crop so it scales with resolution; floored so it survives small crops. The pad keeps
    // the ascenders of the marker line.
    const GAP = Math.max(20, Math.round(0.04 * H));
    const pad = Math.max(2, Math.round(0.01 * H));
    if (markerTop <= GAP) return noop; // not enough room for a band + gap above the marker

    // (1) The window immediately above the marker must be CLEAN (a true gap). If ink reaches
    //     up to the marker, the content above is part of this question's block ⇒ keep.
    for (let y = Math.max(0, markerTop - GAP); y < markerTop; y += 1)
      if (rowDark(y) >= rowThresh) return noop;

    // (2) There must be an inked band ABOVE the gap (the header). Pure blank margin above is
    //     left to trimBlankMargins, not cut here.
    let hasBand = false;
    for (let y = 0; y < markerTop - GAP; y += 1)
      if (rowDark(y) >= rowThresh) {
        hasBand = true;
        break;
      }
    if (!hasBand) return noop;

    // Confirmed header band + clean gap. Cut everything above (markerTop - pad).
    const cut = Math.max(1, markerTop - pad);
    const newH = H - cut;
    if (cut >= H || newH < Math.round(0.2 * H)) return noop; // implausible ⇒ keep original

    const out = await sharp(crop)
      .extract({ left: 0, top: cut, width: W, height: newH })
      .png()
      .toBuffer();
    return { crop: out, regionY0: opts.regionY0 + cut };
  } catch {
    return noop; // best-effort: never break or hole the saved crop
  }
};

const trimBlankMargins = async (
  crop: Buffer,
  opts: { words: WBox[]; regionX0: number; regionY0: number },
): Promise<Buffer> => {
  if (!displayCropTrimEnabled()) return crop;
  try {
    const { data, info } = await sharp(crop).greyscale().raw().toBuffer({ resolveWithObject: true });
    const W = info.width;
    const H = info.height;
    if (!W || !H) return crop;

    // Localise word boxes to crop coordinates (keeping TEXT, for option-label detection); keep only
    // those overlapping the crop.
    const words: Array<WBox & { text: string }> = [];
    for (const w of opts.words) {
      const x0 = w.x0 - opts.regionX0;
      const y0 = w.y0 - opts.regionY0;
      const x1 = w.x1 - opts.regionX0;
      const y1 = w.y1 - opts.regionY0;
      if (x1 <= 0 || y1 <= 0 || x0 >= W || y0 >= H) continue;
      words.push({
        x0: Math.max(0, x0),
        y0: Math.max(0, y0),
        x1: Math.min(W - 1, x1),
        y1: Math.min(H - 1, y1),
        text: ((w as { text?: string }).text ?? '').trim(),
      });
    }
    if (words.length === 0) return crop; // no anchor ⇒ low confidence ⇒ keep original
    const heights = words.map((w) => w.y1 - w.y0 + 1).sort((a, b) => a - b);
    const Hw = Math.max(6, heights[heights.length >> 1]);

    // Row dark-ink density (CONTENT_DARK excludes the light CC-315 codes; a single
    // divider pixel per row stays under the row threshold, so the blank band reads blank).
    const rowDark = new Int32Array(H);
    for (let y = 0; y < H; y += 1) {
      let rc = 0;
      const base = y * W;
      for (let x = 0; x < W; x += 1) if (data[base + x] < CONTENT_DARK) rc += 1;
      rowDark[y] = rc;
    }
    const rowThresh = Math.max(3, Math.round(0.01 * W));
    const BLOCK_GAP = Math.max(60, Math.round(0.1 * H));

    let firstRow = -1;
    for (let y = 0; y < H; y += 1)
      if (rowDark[y] >= rowThresh) {
        firstRow = y;
        break;
      }
    let top = firstRow >= 0 ? firstRow : Math.min(...words.map((w) => w.y0));
    let bottom = top;
    if (firstRow >= 0) {
      let gap = 0;
      for (let y = firstRow; y < H; y += 1) {
        if (rowDark[y] >= rowThresh) {
          bottom = y;
          gap = 0;
        } else {
          gap += 1;
          if (gap > BLOCK_GAP) break;
        }
      }
    } else {
      bottom = Math.max(...words.map((w) => w.y1));
    }

    // INCLUDE ALL OPTIONS (the Q49/Q50 failure). A LARGE whitespace gap between the stem/diagram and
    // the option block — or between options — must NEVER cut the options off: the gap-walk above
    // closes `bottom` at the first big blank band, which can sit ABOVE the options. Extend `bottom` to
    // the LOWEST option-label word in the crop (A/B/C/D or 1–4, incl. glued "A)alpha"), so every
    // option is captured regardless of the gap size. The solution below carries NO option labels, so
    // it is NOT pulled in (and the explanation trim already removed any same-crop solution). The
    // dark-below / diagram guards then evaluate the band BELOW the real options. Value-free, structural.
    const OPT_LABEL_TOK = /^\(?[A-Da-d1-4][.)]/;
    let lowestOptY = -1;
    for (const w of words) if (OPT_LABEL_TOK.test(w.text) && w.y1 > lowestOptY) lowestOptY = w.y1;
    if (lowestOptY > bottom) bottom = Math.min(H - 1, lowestOptY);

    // CONFIDENCE: if there is substantial dark ink below the block (more than a footer
    // rule + page number would have), it could be a diagram separated by a gap — too
    // risky to cut, so keep the original crop.
    const maxFooterRows = Math.max(10, Math.round(2 * Hw));
    let darkBelow = 0;
    for (let y = Math.min(H - 1, bottom + 4); y < H; y += 1) if (rowDark[y] >= rowThresh) darkBelow += 1;
    if (darkBelow > maxFooterRows) return crop;

    // P0 — DIAGRAM-BELOW-GAP guard (generic / value-free / content-first). The gap-walk above
    // closes `bottom` at the first whitespace band > BLOCK_GAP. A DIAGRAM / graph / chemistry
    // structure that sits below that internal gap is WORDLESS, so GROW/CONTAIN (word-box driven)
    // never pull it back in, and a SPARSE one slips under the row-count guard above → it gets CUT.
    // Distinguish a DRAWING from footer / page-number / solution TEXT by ink-vs-word-boxes: a
    // drawing has dark ink OUTSIDE every OCR word box; text ink is INSIDE word boxes. Any real
    // drawing below the gap ⇒ KEEP the whole crop (never clip a diagram). Full-width divider /
    // separator rows are excluded (they are chrome, not a drawing). This can only KEEP MORE, never
    // cut more — so it cannot introduce a false-positive clip. Tunable via OCR_TRIM_DIAGRAM_ROWS.
    {
      const belowTop = Math.min(H - 1, bottom + 4);
      const wordCover = new Uint8Array(W * H);
      for (const w of words) {
        const yA = Math.max(0, w.y0);
        const yB = Math.min(H - 1, w.y1);
        const xA = Math.max(0, w.x0);
        const xB = Math.min(W - 1, w.x1);
        for (let y = yA; y <= yB; y += 1) {
          const b = y * W;
          for (let x = xA; x <= xB; x += 1) wordCover[b + x] = 1;
        }
      }
      const minDiagramRows = Math.max(2, Math.round(Number(process.env.OCR_TRIM_DIAGRAM_ROWS) || Hw * 0.25));
      let diagramRows = 0;
      for (let y = belowTop; y < H && diagramRows <= minDiagramRows; y += 1) {
        const base = y * W;
        let dark = 0;
        let orphan = 0;
        for (let x = 0; x < W; x += 1) {
          if (data[base + x] < CONTENT_DARK) {
            dark += 1;
            if (!wordCover[base + x]) orphan += 1;
          }
        }
        if (dark >= 0.45 * W) continue; // full-width line (divider/separator) ⇒ chrome, not a drawing
        if (orphan >= rowThresh) diagramRows += 1;
      }
      if (diagramRows > minDiagramRows) return crop; // a drawing sits below the gap ⇒ keep the whole crop
    }

    // Grow the block through nearby word boxes (options density may miss); a far-below
    // footer word is outside GROW and stays excluded. Iterate to stability.
    const GROW = Math.round(2.5 * Hw);
    for (let changed = true; changed; ) {
      changed = false;
      for (const w of words) {
        if (w.y0 <= bottom + GROW && w.y1 > bottom) {
          bottom = w.y1;
          changed = true;
        }
        if (w.y1 >= top - GROW && w.y0 < top) {
          top = w.y0;
          changed = true;
        }
      }
    }
    top = Math.max(0, top);
    bottom = Math.min(H - 1, bottom);

    // Columns within [top,bottom]: exclude isolated full-height divider lines.
    const blockH = bottom - top + 1;
    const colDark = new Int32Array(W);
    for (let y = top; y <= bottom; y += 1) {
      const base = y * W;
      for (let x = 0; x < W; x += 1) if (data[base + x] < CONTENT_DARK) colDark[x] += 1;
    }
    const isDivider = (x: number): boolean =>
      colDark[x] >= 0.7 * blockH &&
      (x < 2 || colDark[x - 2] < 0.2 * blockH) &&
      (x > W - 3 || colDark[x + 2] < 0.2 * blockH);
    const colThresh = Math.max(3, Math.round(0.01 * blockH));
    let left = W;
    let right = -1;
    for (let x = 0; x < W; x += 1)
      if (colDark[x] >= colThresh && !isDivider(x)) {
        if (x < left) left = x;
        if (x > right) right = x;
      }

    // CONTAIN every in-block word box — the hard no-clip guarantee for text/options.
    for (const w of words) {
      if (w.y1 < top || w.y0 > bottom) continue; // footer / out-of-block word
      if (w.x0 < left) left = w.x0;
      if (w.x1 > right) right = w.x1;
      if (w.y0 < top) top = w.y0;
      if (w.y1 > bottom) bottom = w.y1;
    }
    if (right < left || bottom < top) return crop;

    const tx0 = Math.max(0, left - PAD);
    const ty0 = Math.max(0, top - PAD);
    const tx1 = Math.min(W - 1, right + PAD);
    const ty1 = Math.min(H - 1, bottom + PAD);
    const tw = tx1 - tx0 + 1;
    const th = ty1 - ty0 + 1;
    if (tw <= 0 || th <= 0) return crop;
    if ((tw * th) / (W * H) >= SKIP_IF_FILLED) return crop; // already full ⇒ nothing to gain
    if (th < Hw || tw < Hw) return crop; // implausibly small ⇒ keep original

    return await sharp(crop).extract({ left: tx0, top: ty0, width: tw, height: th }).png().toBuffer();
  } catch {
    return crop; // best-effort: never break or hole the saved crop
  }
};
