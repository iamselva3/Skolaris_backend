/*
 * DOCUMENT-DRIVEN OCR PROFILE — self-adaptive thresholds.
 *
 * The OCR/display pipeline historically read ~35 static thresholds from process.env
 * (ink-dark cutoffs, whitespace gaps, mask luma bounds, repeat fractions, …). That forced
 * an engineer to hand-tune .env per PDF — not a product. This module replaces those static
 * values with thresholds DERIVED from each uploaded document's own measured statistics:
 *
 *   pages + OCR word boxes + flat field  →  DocumentProfile  →  every threshold
 *
 * It is VALUE-FREE and pattern-based: every number comes from the document's luma histogram,
 * glyph geometry, whitespace distribution, or cross-page persistence — NEVER from a PDF name,
 * institute, subject, question count, or a hardcoded coordinate. A small/large/dense/sparse/
 * single-/multi-column PDF each computes its OWN profile.
 *
 * .env is demoted to OVERRIDE-ONLY (emergency kill switch / forced value). Precedence:
 *   explicit env  >  document-derived  >  static fallback (only when no profile, e.g. 1 image)
 * via `pick(envName, profileValue, fallback)`.
 *
 * It feeds the DISPLAY + segmentation thresholds; it never changes WHICH pixels OCR reads
 * other than through the same derived cutoffs the engine already applied — so N=N / boundaries
 * are governed by the document, not by tuning.
 */
import sharp from 'sharp';
import type { OcrWordBox } from './column-reorder';
import type { FlatField } from './watermark-clean';

/** Numeric env override: returns the parsed number ONLY when the var is explicitly set to a
 *  finite number; otherwise undefined (so the derived value wins). Empty / unset / NaN ⇒ undefined. */
export const envNum = (name: string): number | undefined => {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Threshold precedence: explicit env override > document-derived > static fallback. */
export const pick = (envName: string, derived: number | undefined, fallback: number): number => {
  const e = envNum(envName);
  if (e !== undefined) return e;
  return derived !== undefined && Number.isFinite(derived) ? derived : fallback;
};

/**
 * Per-document profile. All fields are MEASURED from the document; consumers map their static
 * constants onto these semantic fields (see THRESHOLD MAP at the bottom). Luma fields are 0..255.
 */
export interface DocumentProfile {
  // ── luma / ink (from the aggregate page histogram) ─────────────────────────
  /** Otsu valley between ink and paper — the canonical "is this pixel ink?" cutoff. */
  inkValley: number;
  /** Darkest-ink cluster centre — "hard ink / watermark core" cutoff (< this ⇒ definite dark stroke). */
  coreDark: number;
  /** Dominant paper-background luma (the bright peak). */
  paperWhite: number;
  /** paperWhite minus a small margin — "content-capable / protect-as-white" cutoff. */
  brightCeil: number;

  // ── geometry (from OCR word boxes) ─────────────────────────────────────────
  /** Median glyph/line height in page pixels — the document's geometric unit. */
  lineHeight: number;
  /** Typical question/block separation gap (px) — derived from the inter-line gap distribution. */
  blockGap: number;
  /** Median horizontal option spacing (px) between adjacent option markers, when measurable. */
  optionSpacing: number;
  /** Estimated reading columns (1 or 2) from the vertical-gutter ink projection. */
  columnCount: number;

  // ── densities (fractions 0..1) ─────────────────────────────────────────────
  textDensity: number;      // dark-pixel fraction over the whole document
  whitespaceDensity: number; // 1 - textDensity
  footerDensity: number;    // dark fraction in the bottom band
  headerDensity: number;    // dark fraction in the top band
  borderDensity: number;    // dark fraction in the outer frame ring
  diagramDensity: number;   // ink OUTSIDE word boxes / total ink (drawing-ness)

  // ── cross-page persistence / watermark (from the flat field) ───────────────
  hasFlatField: boolean;
  /** Persistent-grey low edge (watermark candidate floor) from the flat-field histogram. */
  wmGreyFloor: number;
  /** Persistent white-or-near-white ceiling from the flat-field histogram. */
  wmBrightCeil: number;
  /** Fraction of the page that is persistent grey (a watermark-density proxy). */
  repeatFrac: number;

  // ── page dims ──────────────────────────────────────────────────────────────
  pageWidth: number;
  pageHeight: number;
  pageCount: number;
}

/** Evenly spread up to `max` items. */
const spread = <T>(a: T[], max: number): T[] => {
  if (a.length <= max) return a;
  const out: T[] = [];
  for (let i = 0; i < max; i += 1) out.push(a[Math.min(a.length - 1, Math.floor((i * a.length) / max))]);
  return out;
};

const median = (a: number[]): number => {
  if (a.length === 0) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
};

/** Otsu's method over a 256-bin luma histogram → the ink/paper separating value. */
const otsu = (hist: number[]): number => {
  const total = hist.reduce((s, v) => s + v, 0);
  if (total === 0) return 150;
  let sum = 0;
  for (let t = 0; t < 256; t += 1) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let thresh = 150;
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      thresh = t;
    }
  }
  return thresh;
};

/** Centre of the darkest histogram mass below `valley` (the "hard ink" cluster). */
const darkClusterCentre = (hist: number[], valley: number): number => {
  let num = 0;
  let den = 0;
  for (let t = 0; t < valley; t += 1) {
    num += t * hist[t];
    den += hist[t];
  }
  return den > 0 ? Math.round(num / den) : Math.round(valley * 0.7);
};

/** Brightest histogram peak in [minBin, 255] (the paper-white background). */
const brightPeak = (hist: number[], minBin: number): number => {
  let best = 255;
  let bestC = -1;
  for (let t = minBin; t < 256; t += 1) {
    if (hist[t] > bestC) {
      bestC = hist[t];
      best = t;
    }
  }
  return best;
};

/** Cluster word boxes on a page into text lines (by vertical overlap) and return inter-line gaps. */
const interLineGaps = (words: OcrWordBox[], lineH: number): number[] => {
  if (words.length < 2) return [];
  const sorted = words.slice().sort((a, b) => a.y0 - b.y0);
  const lines: Array<{ y0: number; y1: number }> = [];
  for (const w of sorted) {
    const last = lines[lines.length - 1];
    if (last && w.y0 <= last.y1 + lineH * 0.5) {
      last.y0 = Math.min(last.y0, w.y0);
      last.y1 = Math.max(last.y1, w.y1);
    } else lines.push({ y0: w.y0, y1: w.y1 });
  }
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const g = lines[i].y0 - lines[i - 1].y1;
    if (g > 0) gaps.push(g);
  }
  return gaps;
};

/**
 * Compute the document profile. Reads a SAMPLE of page rasters (for the luma histogram +
 * densities) and ALL word boxes (for geometry). Best-effort: any failure falls back to the
 * static-default profile so the pipeline never breaks.
 */
export const computeDocumentProfile = async (
  pages: Buffer[],
  wordBoxesByPage: OcrWordBox[][],
  flatField: FlatField | null,
): Promise<DocumentProfile> => {
  const fallback = staticDefaultProfile();
  try {
    if (pages.length === 0) return fallback;
    const meta = await sharp(pages[0]).metadata();
    const PW = meta.width ?? 0;
    const PH = meta.height ?? 0;
    if (!PW || !PH) return fallback;

    // ── aggregate luma histogram + density bands over sampled pages ───────────
    const hist = new Array(256).fill(0);
    let darkTotal = 0;
    let pxTotal = 0;
    let footerDark = 0;
    let footerPx = 0;
    let headerDark = 0;
    let headerPx = 0;
    let borderDark = 0;
    let borderPx = 0;
    const sample = spread(pages, 4);
    // Provisional ink cutoff for density bands (refined to Otsu after the histogram is built).
    const PROV_INK = 150;
    for (const buf of sample) {
      const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
      const w = info.width;
      const h = info.height;
      if (!w || !h) continue;
      const topBand = Math.round(h * 0.12);
      const botBand = Math.round(h * 0.88);
      const ringX = Math.round(w * 0.04);
      const ringY = Math.round(h * 0.04);
      for (let y = 0; y < h; y += 1) {
        const base = y * w;
        const inTop = y < topBand;
        const inBot = y >= botBand;
        const inRingY = y < ringY || y >= h - ringY;
        for (let x = 0; x < w; x += 1) {
          const v = data[base + x];
          hist[v] += 1;
          pxTotal += 1;
          const dark = v < PROV_INK;
          if (dark) darkTotal += 1;
          if (inTop) { headerPx += 1; if (dark) headerDark += 1; }
          if (inBot) { footerPx += 1; if (dark) footerDark += 1; }
          if (inRingY || x < ringX || x >= w - ringX) { borderPx += 1; if (dark) borderDark += 1; }
        }
      }
    }
    const inkValley = otsu(hist);
    const coreDark = darkClusterCentre(hist, inkValley);
    const paperWhite = brightPeak(hist, Math.max(inkValley + 1, 180));
    const brightCeil = Math.round(paperWhite - Math.max(8, (paperWhite - inkValley) * 0.08));

    // ── geometry from word boxes ──────────────────────────────────────────────
    const allWords = wordBoxesByPage.flat();
    const heights = allWords.map((w) => w.y1 - w.y0).filter((h) => h > 0);
    const lineHeight = Math.max(6, median(heights) || Math.round(PH * 0.012));
    const gaps: number[] = [];
    for (const ws of wordBoxesByPage) gaps.push(...interLineGaps(ws, lineHeight));
    // A block/question gap is materially larger than the typical intra-paragraph line gap.
    const medGap = median(gaps) || lineHeight;
    const blockGap = Math.round(Math.max(lineHeight * 1.5, medGap * 2.2));

    // option horizontal spacing: adjacent same-line word starts near option markers (a..d / 1..4)
    const OPT = /^\(?[A-Da-d1-4][)\].:]/;
    const optGaps: number[] = [];
    for (const ws of wordBoxesByPage) {
      const opts = ws.filter((w) => OPT.test(w.text)).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
      for (let i = 1; i < opts.length; i += 1) {
        if (Math.abs(opts[i].y0 - opts[i - 1].y0) <= lineHeight && opts[i].x0 > opts[i - 1].x0) {
          optGaps.push(opts[i].x0 - opts[i - 1].x0);
        }
      }
    }
    const optionSpacing = Math.round(median(optGaps) || PW * 0.4);

    // column count: vertical ink projection on the densest sampled page → central gutter?
    const columnCount = await estimateColumns(sample, PW, inkValley);

    // diagram density: ink outside word boxes / total ink (drawing-ness), on the first sampled page
    const diagramDensity = await estimateDiagramDensity(sample[0], wordBoxesByPage[0] ?? [], inkValley);

    // ── flat-field-derived watermark luma bounds + repeat fraction ────────────
    let wmGreyFloor = fallback.wmGreyFloor;
    let wmBrightCeil = fallback.wmBrightCeil;
    let repeatFrac = 0;
    if (flatField && flatField.data.length) {
      const fh = new Array(256).fill(0);
      for (let i = 0; i < flatField.data.length; i += 1) fh[flatField.data[i]] += 1;
      const fValley = otsu(fh);
      const fWhite = brightPeak(fh, Math.max(fValley + 1, 200));
      // Persistent-grey band sits between the dark valley and just under the white peak.
      wmGreyFloor = Math.round(Math.max(60, Math.min(160, darkClusterCentre(fh, fValley) + (fValley - darkClusterCentre(fh, fValley)) * 0.5)));
      wmBrightCeil = Math.round(Math.max(wmGreyFloor + 40, fWhite - Math.max(6, (fWhite - fValley) * 0.06)));
      let grey = 0;
      for (let i = 0; i < flatField.data.length; i += 1) {
        const v = flatField.data[i];
        if (v >= wmGreyFloor && v < wmBrightCeil) grey += 1;
      }
      repeatFrac = grey / flatField.data.length;
    }

    const textDensity = pxTotal ? darkTotal / pxTotal : fallback.textDensity;
    return {
      inkValley,
      coreDark,
      paperWhite,
      brightCeil,
      lineHeight,
      blockGap,
      optionSpacing,
      columnCount,
      textDensity,
      whitespaceDensity: 1 - textDensity,
      footerDensity: footerPx ? footerDark / footerPx : 0,
      headerDensity: headerPx ? headerDark / headerPx : 0,
      borderDensity: borderPx ? borderDark / borderPx : 0,
      diagramDensity,
      hasFlatField: !!flatField,
      wmGreyFloor,
      wmBrightCeil,
      repeatFrac,
      pageWidth: PW,
      pageHeight: PH,
      pageCount: pages.length,
    };
  } catch {
    return fallback;
  }
};

/** Vertical-gutter detection over the densest sampled page → 2 columns when a clean central river exists. */
const estimateColumns = async (sample: Buffer[], pageWidth: number, inkValley: number): Promise<number> => {
  try {
    const buf = sample[Math.floor(sample.length / 2)] ?? sample[0];
    if (!buf) return 1;
    const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
    const w = info.width;
    const h = info.height;
    if (!w || !h) return 1;
    const col = new Array(w).fill(0);
    for (let y = 0; y < h; y += 1) {
      const base = y * w;
      for (let x = 0; x < w; x += 1) if (data[base + x] < inkValley) col[x] += 1;
    }
    // central third: a sustained near-zero-ink vertical band ⇒ a gutter ⇒ 2 columns
    const lo = Math.round(w * 0.4);
    const hi = Math.round(w * 0.6);
    const colMax = Math.max(1, ...col);
    let gutter = 0;
    for (let x = lo; x < hi; x += 1) if (col[x] < colMax * 0.04) gutter += 1;
    return gutter >= (hi - lo) * 0.5 ? 2 : 1;
  } catch {
    return 1;
  }
};

/** Drawing-ness: fraction of ink pixels that fall OUTSIDE any OCR word box. */
const estimateDiagramDensity = async (page: Buffer | undefined, words: OcrWordBox[], inkValley: number): Promise<number> => {
  try {
    if (!page) return 0;
    const { data, info } = await sharp(page).greyscale().raw().toBuffer({ resolveWithObject: true });
    const w = info.width;
    const h = info.height;
    if (!w || !h) return 0;
    const cover = new Uint8Array(w * h);
    for (const wd of words) {
      const xA = Math.max(0, Math.floor(wd.x0));
      const xB = Math.min(w - 1, Math.ceil(wd.x1));
      const yA = Math.max(0, Math.floor(wd.y0));
      const yB = Math.min(h - 1, Math.ceil(wd.y1));
      for (let y = yA; y <= yB; y += 1) { const b = y * w; for (let x = xA; x <= xB; x += 1) cover[b + x] = 1; }
    }
    let ink = 0;
    let orphan = 0;
    for (let i = 0; i < w * h; i += 1) if (data[i] < inkValley) { ink += 1; if (!cover[i]) orphan += 1; }
    return ink ? orphan / ink : 0;
  } catch {
    return 0;
  }
};

/**
 * Static-default profile — the legacy literals, used ONLY when no document statistics are
 * available (e.g. a single-image upload, or a failure). Keeps behaviour identical to pre-profile
 * for those edge cases; multi-page PDFs always get a real measured profile.
 */
export const staticDefaultProfile = (): DocumentProfile => ({
  inkValley: 150,
  coreDark: 115,
  paperWhite: 252,
  brightCeil: 238,
  lineHeight: 20,
  blockGap: 60,
  optionSpacing: 300,
  columnCount: 1,
  textDensity: 0.08,
  whitespaceDensity: 0.92,
  footerDensity: 0,
  headerDensity: 0,
  borderDensity: 0,
  diagramDensity: 0,
  hasFlatField: false,
  wmGreyFloor: 110,
  wmBrightCeil: 238,
  repeatFrac: 0,
  pageWidth: 0,
  pageHeight: 0,
  pageCount: 0,
});

/*
 * THRESHOLD MAP — how each legacy static constant becomes document-driven (env = override only):
 *   crop-display-trim.ts   CONTENT_DARK 150        → pick('OCR_DISPLAY_TRIM_DARK', profile.inkValley, 150)
 *                          PAD 14                  → pick('OCR_DISPLAY_TRIM_PAD', round(profile.lineHeight*0.7), 14)
 *                          diagramRows Hw*0.25     → already line-relative (kept)
 *   crop-display-clean.ts  CORE_DARK 115           → profile.coreDark
 *                          PROTECT_ABOVE 235       → profile.brightCeil (−small)
 *                          WHITE_POINT 232         → profile.brightCeil
 *                          BG_INK_DARK/HARD/DIV/HSEP/CC → profile.inkValley family
 *                          KEEP_MARGIN 28/HALO/BG_HALO  → profile.lineHeight multiples
 *   watermark-clean.ts     WM_MASK_GREY_FLOOR 110  → profile.wmGreyFloor
 *                          WM_MASK_BRIGHT_CEIL 238 → profile.wmBrightCeil
 *                          WM_MASK_DILATE 4        → round(profile.lineHeight*0.2)
 *   visual-segment.ts      block/question gaps     → profile.blockGap
 *                          option spacing          → profile.optionSpacing
 */
