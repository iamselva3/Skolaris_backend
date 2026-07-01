import sharp from 'sharp';

/**
 * OPTIONAL PAGE-CHROME CLEANUP — a small, pure Sharp utility (NOT a phase, NOT a detector, NOT a
 * pipeline). It prepares a cleaner page BEFORE the (unchanged) OCR engine. It NEVER imports or touches
 * `src/shared/ocr-engine/*`, the OCR use-cases, or any downstream component. Default-OFF; wired into
 * NOTHING here.
 *
 * WHAT IT REMOVES (only provably-safe chrome):
 *   • HEADER / FOOTER — by CROSS-PAGE REPETITION. A header/footer is the SAME pixels at the SAME
 *     position on MOST pages; question content (a continuation formula, an option block, "Statement I…")
 *     is UNIQUE to its page. So we whiten, in the top/bottom margin strips ONLY, the pixels that are
 *     inked on ≥ REPEAT_FRAC of pages — repeated chrome. Unique content pixels are NEVER in the mask,
 *     so they are never touched. (This is why a real header/footer is removed but a question that
 *     happens to sit at the top/bottom of a page is preserved.)
 *   • OUTER BORDER lines and the central COLUMN DIVIDER — thin, near-full-extent, isolated rules
 *     (geometry only).
 *
 * GOLDEN RULE — content is immutable. Header/footer removal acts ONLY on pixels repeated across pages
 * (chrome), and ONLY inside the top/bottom margin strips, and ONLY on a page that actually carries that
 * chrome (per-page overlap gate). Borders/divider are thin isolated rules. If uncertain → DO NOTHING
 * (a page with no repeated chrome and no frame is returned unchanged — identity). No OCR, no question/
 * option detection, no institute/PDF-specific rules — only geometry + cross-page agreement.
 *
 * Forbidden (never used): single-page band removal, global/adaptive thresholding, deskew, despeckle,
 * denoise, morphology, auto-trim, any whole-page transform.
 */

const INK_DARK = Number(process.env.PRE_CHROME_INK_DARK ?? 165);
/** A pixel is "non-background" (chrome-eligible) if it is DARK (lum < INK_DARK) OR COLOURED (channel
 *  spread max-min > SAT_MIN). This catches a colored LOGO that a dark-only threshold misses, while
 *  white/near-grey page background (spread ≈ 0, light) stays background. Generic — no colour values. */
const SAT_MIN = Number(process.env.PRE_CHROME_SAT_MIN ?? 28);
/** Header/footer repeated-ink is searched only in this fraction of the top and bottom of the page. */
const BAND_ZONE = Number(process.env.PRE_CHROME_BAND_ZONE ?? 0.16);
/** A strip pixel is repeated CHROME if it is inked on at least this fraction of pages. */
const REPEAT_FRAC = Number(process.env.PRE_CHROME_REPEAT_FRAC ?? 0.7);
/** Cross-page repetition needs at least this many pages to be reliable; fewer ⇒ no header/footer removal. */
const MIN_PAGES = Number(process.env.PRE_CHROME_MIN_PAGES ?? 4);
/** A page is treated as carrying the chrome only if it contains at least this fraction of the mask's
 *  ink (protects mixed docs: a content page that lacks the header is skipped, never whitened). */
const OVERLAP_MIN = Number(process.env.PRE_CHROME_OVERLAP_MIN ?? 0.6);
/** A repeated-ink mask covering less than this FRACTION of a margin strip is treated as noise ⇒
 *  ignored (clean no-op). A fraction (not an absolute pixel count) so it is resolution-independent. */
const MIN_MASK_FRAC = Number(process.env.PRE_CHROME_MIN_MASK_FRAC ?? 0.00015);
/** Expand the repeated mask by this many px to absorb anti-aliased glyph halos (no trail). Kept small
 *  so it stays inside the chrome region — the header→body gutter keeps it away from content. */
const MASK_DILATE_PX = Number(process.env.PRE_CHROME_MASK_DILATE ?? 2);
/** Outer border lines / divider geometry. */
const BORDER_ZONE = Number(process.env.PRE_CHROME_BORDER_ZONE ?? 0.04);
const DIVIDER_LO = Number(process.env.PRE_CHROME_DIVIDER_LO ?? 0.3);
const DIVIDER_HI = Number(process.env.PRE_CHROME_DIVIDER_HI ?? 0.7);
const LINE_INK = Number(process.env.PRE_CHROME_LINE_INK ?? 0.6);
const LINE_MAX_THICK = Number(process.env.PRE_CHROME_LINE_THICK ?? 0.006);
const ISO_EMPTY = Number(process.env.PRE_CHROME_ISO_EMPTY ?? 0.03);
const ISO_PAD_FRAC = Number(process.env.PRE_CHROME_ISO_PAD ?? 0.01);

export type ChromeKind = 'header-repeat' | 'footer-repeat' | 'border-top' | 'border-bottom' | 'border-left' | 'border-right' | 'column-divider';
export interface ChromeRect { x: number; y: number; w: number; h: number; kind: ChromeKind; }

/** Document-level profile: the repeated header/footer ink masks (built from ALL pages). */
export interface ChromeProfile {
  W: number;
  H: number;
  stripH: number;
  pages: number;
  topMask: Uint8Array | null; // W×stripH, 1 = repeated chrome pixel in the top strip (dilated)
  botMask: Uint8Array | null; // W×stripH, 1 = repeated chrome pixel in the bottom strip (dilated)
  topMaskInk: number; // set pixels in the dilated mask (informational)
  botMaskInk: number;
  topCoreInk: number; // set pixels in the CORE mask (pre-dilation) — denominator for the overlap gate
  botCoreInk: number;
}

export interface ChromeCleanupResult { changed: boolean; image: Buffer; removed: ChromeRect[]; maskedPixels: number; }

/** Expand set pixels of a W×H binary mask by `r` px (separable box dilation, clamped to bounds). */
const dilate = (mask: Uint8Array, W: number, H: number, r: number): void => {
  if (r <= 0) return;
  // horizontal pass
  const tmp = new Uint8Array(mask.length);
  for (let y = 0; y < H; y += 1) {
    const row = y * W;
    for (let x = 0; x < W; x += 1) {
      let on = 0;
      for (let dx = -r; dx <= r && !on; dx += 1) { const xx = x + dx; if (xx >= 0 && xx < W && mask[row + xx]) on = 1; }
      tmp[row + x] = on;
    }
  }
  // vertical pass
  for (let y = 0; y < H; y += 1) {
    const row = y * W;
    for (let x = 0; x < W; x += 1) {
      let on = 0;
      for (let dy = -r; dy <= r && !on; dy += 1) { const yy = y + dy; if (yy >= 0 && yy < H && tmp[yy * W + x]) on = 1; }
      mask[row + x] = on;
    }
  }
};

/** Raw RGB (alpha removed) so colour is visible — needed to catch a coloured logo. */
const rawRGB = async (img: Buffer): Promise<{ data: Buffer; W: number; H: number }> => {
  const { data, info } = await sharp(img).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height };
};
/** luminance of pixel index `p` (p = y*W + x) in an RGB buffer. */
const lumAt = (rgb: Buffer, p: number): number => { const o = p * 3; return (rgb[o] * 299 + rgb[o + 1] * 587 + rgb[o + 2] * 114) / 1000; };
/** non-background = DARK or COLOURED (channel spread). */
const nonBgAt = (rgb: Buffer, p: number): boolean => {
  const o = p * 3; const r = rgb[o]; const g = rgb[o + 1]; const b = rgb[o + 2];
  if ((r * 299 + g * 587 + b * 114) / 1000 < INK_DARK) return true; // dark ink
  return Math.max(r, g, b) - Math.min(r, g, b) > SAT_MIN; // coloured (e.g. a logo)
};
/** Build a luminance Uint8 buffer (so the geometric border/divider code can run unchanged). */
const lumBuffer = (rgb: Buffer, W: number, H: number): Uint8Array => {
  const out = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p += 1) out[p] = lumAt(rgb, p);
  return out;
};

/**
 * Build the document-level repeated header/footer masks from ALL pages. A top/bottom strip pixel is
 * marked chrome iff it is inked (< INK_DARK) on ≥ REPEAT_FRAC of pages. Returns null masks when there
 * are too few pages for repetition to be reliable.
 */
export const buildChromeProfile = async (pages: ReadonlyArray<Buffer>): Promise<ChromeProfile> => {
  const first = await rawRGB(pages[0]);
  const { W, H } = first;
  const stripH = Math.max(1, Math.round(H * BAND_ZONE));
  const empty: ChromeProfile = { W, H, stripH, pages: pages.length, topMask: null, botMask: null, topMaskInk: 0, botMaskInk: 0, topCoreInk: 0, botCoreInk: 0 };
  if (pages.length < MIN_PAGES) return empty;

  // TWO repetition counts per strip:
  //   *Dark*       — confirms a header/footer EXISTS (repeated dark text). Gate only.
  //   *Non-bg*     — the REMOVAL mask: dark OR coloured pixels (so a coloured LOGO is included).
  const topDark = new Uint32Array(W * stripH);
  const botDark = new Uint32Array(W * stripH);
  const topNon = new Uint32Array(W * stripH);
  const botNon = new Uint32Array(W * stripH);
  for (const pg of pages) {
    const { data, W: pw, H: ph } = await rawRGB(pg);
    if (pw !== W || ph !== H) continue; // size mismatch ⇒ skip (never guess)
    for (let y = 0; y < stripH; y += 1) {
      const dst = y * W;
      const topRow = y * W;
      const botRow = (H - stripH + y) * W;
      for (let x = 0; x < W; x += 1) {
        if (lumAt(data, topRow + x) < INK_DARK) topDark[dst + x] += 1;
        if (lumAt(data, botRow + x) < INK_DARK) botDark[dst + x] += 1;
        if (nonBgAt(data, topRow + x)) topNon[dst + x] += 1;
        if (nonBgAt(data, botRow + x)) botNon[dst + x] += 1;
      }
    }
  }
  const need = Math.ceil(REPEAT_FRAC * pages.length);
  const minInk = Math.max(16, Math.round(MIN_MASK_FRAC * W * stripH)); // noise floor, scaled to strip size
  const build = (dark: Uint32Array, non: Uint32Array): { mask: Uint8Array; core: number; confirmed: boolean } => {
    let darkCore = 0;
    const mask = new Uint8Array(W * stripH);
    let core = 0;
    for (let i = 0; i < mask.length; i += 1) {
      if (dark[i] >= need) darkCore += 1;           // repeated dark text ⇒ header-confirming
      if (non[i] >= need) { mask[i] = 1; core += 1; } // repeated non-bg (text + logo) ⇒ removal mask
    }
    // A header/footer is removed ONLY when CONFIRMED by repeated dark text. A region that merely has a
    // repeated coloured blob but no repeated text is NOT treated as chrome (conservative).
    const confirmed = darkCore >= minInk && core >= minInk;
    if (confirmed) dilate(mask, W, stripH, MASK_DILATE_PX);
    return { mask, core, confirmed };
  };
  const t = build(topDark, topNon);
  const b = build(botDark, botNon);
  return {
    W, H, stripH, pages: pages.length,
    topMask: t.confirmed ? t.mask : null, botMask: b.confirmed ? b.mask : null,
    topMaskInk: t.confirmed ? t.mask.reduce((s, v) => s + v, 0) : 0,
    botMaskInk: b.confirmed ? b.mask.reduce((s, v) => s + v, 0) : 0,
    topCoreInk: t.confirmed ? t.core : 0, botCoreInk: b.confirmed ? b.core : 0,
  };
};

/* ── geometric thin-line helpers (borders + divider) ── */
const lineRuns = (cells: number[], ink: Float32Array, maxThick: number): Array<[number, number]> => {
  const runs: Array<[number, number]> = [];
  let start = -1; let len = 0;
  const flush = (): void => { if (start >= 0 && len <= maxThick) runs.push([start, len]); start = -1; len = 0; };
  for (const i of cells) { if (ink[i] >= LINE_INK) { if (start < 0) start = i; len += 1; } else flush(); }
  flush();
  return runs;
};
const bestRun = (cells: number[], ink: Float32Array, maxThick: number): [number, number] | null =>
  lineRuns(cells, ink, maxThick).reduce<[number, number] | null>((b, r) => (!b || r[1] > b[1] ? r : b), null);

const colRowInk = (data: Uint8Array | Buffer, W: number, H: number): { rowInk: Float32Array; colInk: Float32Array } => {
  const rowInk = new Float32Array(H);
  const colInk = new Float32Array(W);
  for (let y = 0; y < H; y += 1) {
    const base = y * W; let r = 0;
    for (let x = 0; x < W; x += 1) if (data[base + x] < INK_DARK) { r += 1; colInk[x] += 1; }
    rowInk[y] = r / W;
  }
  for (let x = 0; x < W; x += 1) colInk[x] /= H;
  return { rowInk, colInk };
};

const detectBorders = (rowInk: Float32Array, colInk: Float32Array, W: number, H: number): ChromeRect[] => {
  const out: ChromeRect[] = [];
  const hZone = Math.max(1, Math.round(H * BORDER_ZONE));
  const wZone = Math.max(1, Math.round(W * BORDER_ZONE));
  const maxThH = Math.max(1, Math.round(H * LINE_MAX_THICK));
  const maxThW = Math.max(1, Math.round(W * LINE_MAX_THICK));
  for (const [s, l] of lineRuns([...Array(hZone).keys()], rowInk, maxThH)) out.push({ x: 0, y: s, w: W, h: l, kind: 'border-top' });
  for (const [s, l] of lineRuns([...Array(hZone).keys()].map((i) => H - hZone + i), rowInk, maxThH)) out.push({ x: 0, y: s, w: W, h: l, kind: 'border-bottom' });
  for (const [s, l] of lineRuns([...Array(wZone).keys()], colInk, maxThW)) out.push({ x: s, y: 0, w: l, h: H, kind: 'border-left' });
  for (const [s, l] of lineRuns([...Array(wZone).keys()].map((i) => W - wZone + i), colInk, maxThW)) out.push({ x: s, y: 0, w: l, h: H, kind: 'border-right' });
  return out;
};
const detectDivider = (colInk: Float32Array, W: number, H: number): ChromeRect | null => {
  const lo = Math.round(W * DIVIDER_LO);
  const hi = Math.round(W * DIVIDER_HI);
  const maxThW = Math.max(1, Math.round(W * LINE_MAX_THICK));
  const run = bestRun([...Array(hi - lo).keys()].map((i) => lo + i), colInk, maxThW);
  if (!run) return null;
  const [start, len] = run;
  const pad = Math.max(2, Math.round(W * ISO_PAD_FRAC));
  let l = 0; let ln = 0; let r = 0; let rn = 0;
  for (let x = Math.max(0, start - pad); x < start; x += 1) { l += colInk[x]; ln += 1; }
  for (let x = start + len; x < Math.min(W, start + len + pad); x += 1) { r += colInk[x]; rn += 1; }
  if ((ln ? l / ln : 1) > ISO_EMPTY || (rn ? r / rn : 1) > ISO_EMPTY) return null; // not isolated ⇒ no-op
  return { x: start, y: 0, w: len, h: H, kind: 'column-divider' };
};

/**
 * Sanitize ONE page using the document profile. Whitens: (1) the repeated header/footer chrome pixels
 * in the top/bottom strips (only if THIS page actually carries that chrome — overlap gate), and
 * (2) outer border lines + the central divider (geometry). Returns the original buffer unchanged when
 * nothing qualifies.
 */
export const sanitizePage = async (page: Buffer, profile: ChromeProfile): Promise<ChromeCleanupResult> => {
  const { data, W, H } = await rawRGB(page);
  if (W !== profile.W || H !== profile.H) return { changed: false, image: page, removed: [], maskedPixels: 0 };
  const lum = lumBuffer(data, W, H);
  const { rowInk, colInk } = colRowInk(lum, W, H);
  const stripH = profile.stripH;
  const composites: sharp.OverlayOptions[] = [];
  const removed: ChromeRect[] = [];
  let maskedPixels = 0;

  // (1) repeated header/footer chrome — apply only where this page actually has the chrome ink.
  const applyMask = (mask: Uint8Array | null, coreInk: number, topOffset: number, kind: ChromeKind): void => {
    if (!mask || coreInk === 0) return;
    // per-page overlap: how much of the repeated chrome this page actually carries. Denominator is the
    // CORE (pre-dilation) ink count — the dilation halo (whitespace) must NOT dilute this ratio.
    let overlap = 0;
    for (let y = 0; y < stripH; y += 1) {
      const src = (topOffset + y) * W;
      const m = y * W;
      for (let x = 0; x < W; x += 1) if (mask[m + x] && nonBgAt(data, src + x)) overlap += 1;
    }
    if (overlap / coreInk < OVERLAP_MIN) return; // this page lacks the chrome (e.g. a content page) ⇒ skip
    const rgba = Buffer.alloc(W * stripH * 4); // transparent
    let n = 0;
    for (let i = 0; i < mask.length; i += 1) {
      if (mask[i]) { const o = i * 4; rgba[o] = 255; rgba[o + 1] = 255; rgba[o + 2] = 255; rgba[o + 3] = 255; n += 1; }
    }
    composites.push({ input: rgba, raw: { width: W, height: stripH, channels: 4 }, left: 0, top: topOffset });
    removed.push({ x: 0, y: topOffset, w: W, h: stripH, kind });
    maskedPixels += n;
  };
  applyMask(profile.topMask, profile.topCoreInk, 0, 'header-repeat');
  applyMask(profile.botMask, profile.botCoreInk, H - stripH, 'footer-repeat');

  // (2) borders + divider (thin isolated rules, geometry only)
  for (const r of detectBorders(rowInk, colInk, W, H)) { composites.push({ input: { create: { width: r.w, height: r.h, channels: 3, background: '#ffffff' } }, left: r.x, top: r.y }); removed.push(r); }
  const divider = detectDivider(colInk, W, H);
  if (divider) { composites.push({ input: { create: { width: divider.w, height: divider.h, channels: 3, background: '#ffffff' } }, left: divider.x, top: divider.y }); removed.push(divider); }

  if (composites.length === 0) return { changed: false, image: page, removed: [], maskedPixels: 0 };
  const image = await sharp(page).composite(composites).png().toBuffer();
  return { changed: true, image, removed, maskedPixels };
};

/** Convenience: build the profile and sanitize all pages. */
export const sanitizePages = async (pages: ReadonlyArray<Buffer>): Promise<ChromeCleanupResult[]> => {
  const profile = await buildChromeProfile(pages);
  const out: ChromeCleanupResult[] = [];
  for (const p of pages) out.push(await sanitizePage(p, profile));
  return out;
};
