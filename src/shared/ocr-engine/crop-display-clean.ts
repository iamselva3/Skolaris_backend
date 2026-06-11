import sharp from 'sharp';
import type { FlatField, WatermarkMask } from './watermark-clean';

/**
 * DISPLAY-ONLY watermark cleanup for the FINAL question crop — CONTENT-FIRST.
 *
 * Runs AFTER OCR, segmentation, marker/number/option detection and draft
 * generation. It touches ONLY the pixels of the image shown to the teacher; it
 * never feeds OCR and never changes a region, number, option, boundary or any
 * draft field (all detection ran on word boxes, not on this image).
 *
 *   PDF → OCR → Segmentation → Draft → Final Crop → [cleanCropForDisplay] → Display
 *
 * GOVERNING PRINCIPLE: question content has higher priority than watermark
 * removal. If a pixel is uncertain, KEEP IT. A watermark may remain partially
 * visible; question text, options, math symbols, table borders and especially
 * DIAGRAM strokes must never disappear.
 *
 * Why an earlier luminance approach failed: a light-grey diagram stroke (a tRNA
 * loop, a faint curve) is locally indistinguishable from a light-grey watermark —
 * both are mid-grey with no dark core — so any local rule that removes one removes
 * the other. The ONLY signal that separates them is CROSS-PAGE CONSENSUS: the
 * watermark repeats at the same position on every page; diagram content is unique
 * to its page. The cross-page flat field (per-pixel brightest across pages)
 * encodes exactly this:
 *   • flat is BRIGHT at a pixel ⇒ on some page it was white there ⇒ any darkness on
 *     THIS page is unique content ⇒ PROTECT.
 *   • flat is GREY at a pixel ⇒ that pixel is never white on any page ⇒ a persistent
 *     watermark ⇒ a suppression CANDIDATE — but only the part that is NOT darker
 *     than the persistent background (extra darkness = content drawn over it).
 *
 * BINARY decision — the key to pixel-faithful content. Every pixel is EITHER:
 *   • KEPT  → the code never writes to it, so it is byte-identical to the source
 *             (same thickness, same contrast, same geometry — no fade/thin/blur); OR
 *   • a confident WATERMARK pixel sitting on NON-content → set fully to white.
 * There is NO partial fade. The previous version lifted every borderline pixel by
 * `data[i] = r + (255-r)*t`, which lightened faint content edges (the Q89 "strokes
 * look lighter / contrast changed" report). That blend is removed entirely.
 *
 * A pixel is KEPT (content, or uncertain) when ANY of these hold — generous by design:
 *   (C) it is a dark core or within the dilated halo of one (ink / dark stroke);
 *   (E) its location is content-capable: the flat field is bright there (white on
 *       some page) ⇒ darkness on THIS page is unique content (saves light diagrams);
 *   (D) it is darker than its persistent background by KEEP_MARGIN (content on top
 *       of a watermark — keep the content, do NOT subtract);
 *   (F) it is darker than WHITE_FLOOR (an absolute floor — never whiten anything
 *       that is even moderately dark, whatever the other signals say).
 * Only a pixel failing ALL of the above — light, at a persistent (non-white) grey
 * location, no extra darkness, above the floor — is whitened. Where a watermark
 * overlaps a diagram/formula, (C)/(D)/(F) fire on the content stroke, so the stroke
 * is kept verbatim and only the watermark-only pixels around it go white.
 *
 * No flat field (single-image upload, <3 pages) ⇒ no consensus ⇒ keep everything.
 *
 * PAGE-LEVEL MASK GATE (added). The per-pixel rules above are necessary but not
 * sufficient: a pixel may be whitened ONLY if it ALSO lies inside the page-level
 * large-watermark mask (`buildWatermarkMask`, computed once on the full page with
 * connected-component size filtering). Thin diagram lines, small labels, formula
 * strokes and page codes (CC-315) are never part of a LARGE persistent blob, so
 * they fall outside the mask and are kept verbatim regardless of the local rules.
 * The mask can only REDUCE what is whitened — it never expands it. When no mask
 * is supplied the function behaves exactly as before (flat-field guards only).
 */

export const displayCleanupEnabled = (): boolean =>
  process.env.OCR_DISPLAY_WATERMARK_CLEANUP !== 'false';

/** (C) A pixel this dark is a content CORE (ink / dark diagram stroke / table rule). */
const CORE_DARK = Number(process.env.OCR_DISPLAY_WM_CORE ?? 115);
/** Pixels within this many px of a dark core are protected (the anti-alias halo). */
const HALO = Math.max(0, Math.round(Number(process.env.OCR_DISPLAY_WM_HALO ?? 2)));
/** (E) If the flat field is at least this bright at a pixel, the location is
 *  content-capable (white on some page) → keep whatever is on THIS page. */
const PROTECT_ABOVE = Number(process.env.OCR_DISPLAY_WM_PROTECT_ABOVE ?? 235);
/** (D) Keep any pixel at least this much darker than its persistent background —
 *  extra darkness means content is drawn on top of the watermark. */
const KEEP_MARGIN = Number(process.env.OCR_DISPLAY_WM_KEEP_MARGIN ?? 28);
/** (F) Absolute content floor — never whiten a pixel at or below this luminance,
 *  regardless of the flat field (a hard guarantee for medium-dark strokes). */
const WHITE_FLOOR = Number(process.env.OCR_DISPLAY_WM_WHITE_FLOOR ?? 120);

/**
 * AGGRESSIVE, FLAT-AWARE dark-core removal (OPT-IN; default OFF — the verified
 * output is unchanged unless this is set to 'true'). It answers the "dark watermark
 * strokes survive" / "watermark still visible after the mask pass" problem.
 *
 * The dark-core guards (C) CORE_DARK and (F) WHITE_FLOOR are ABSOLUTE — they keep
 * ANY dark pixel, so a solid/dark watermark stroke (which is just as dark as ink)
 * is always protected. But the flat field already knows which dark pixels are
 * watermark: a pixel that is dark on THIS page AND whose flat field is ALSO dark
 * there is dark on EVERY page ⇒ persistent ⇒ the watermark itself; a dark pixel
 * whose flat is bright is unique ⇒ content. When this flag is on, inside the large
 * mask the (C)/(F) absolute guards are dropped and a dark pixel is whitened ONLY
 * when the flat confirms the darkness is persistent:
 *    • (E) still protects unique-content locations  (flat bright ⇒ kept), and
 *    • (D) still protects content drawn OVER the watermark (darker than the
 *          persistent background by KEEP_MARGIN ⇒ kept).
 * So it removes watermark cores WITHOUT the content loss a flat-blind threshold
 * would cause (a diagram stroke unique to the page has a bright flat and survives
 * via (E); a formula crossing the banner is darker-than-bg and survives via (D)).
 * It depends entirely on flat-field accuracy, so it is gated to the large mask and
 * OFF by default — validate with scripts/diag-mask.ts / diag-display.ts on the real
 * PDF before enabling on a new layout. */
export const persistentCoreEnabled = (): boolean =>
  process.env.OCR_DISPLAY_WM_PERSISTENT_CORE === 'true';

// ---------------------------------------------------------------------------
// CONSERVATIVE BACKGROUND POST-PASSES (additive; run AFTER the mask pass above).
// They only ever set pixels to white, never darken, and are guarded so they
// cannot touch question text/options/formulas/diagrams. Both are reversible via
// env. They do NOT change the mask pass — disabling them restores prior output.
// ---------------------------------------------------------------------------

/** Pass 2 — remove faint watermark TRAILS / fragments that survived OUTSIDE the
 *  large-watermark mask, but ONLY in background far from any real ink. */
export const backgroundCleanupEnabled = (): boolean =>
  process.env.OCR_DISPLAY_BG_CLEANUP !== 'false';
/** Any pixel this dark counts as real INK (text/diagram/formula/table/divider).
 *  Pass 2 protects a halo around all of it and never whitens it. */
const BG_INK_DARK = Number(process.env.OCR_DISPLAY_BG_INK_DARK ?? 150);
/** Protect this many px around every ink pixel (covers anti-alias edges). */
const BG_HALO = Math.max(0, Math.round(Number(process.env.OCR_DISPLAY_BG_HALO ?? 8)));

/**
 * TRAIL mode (OPT-IN; default OFF — Pass 2 is byte-identical until set to 'true').
 * Targets the faint trail that survives Pass 2 in EMPTY background. It survives
 * because a MEDIUM-grey trail pixel (luma in [BG_HARD_INK, BG_INK_DARK)) is itself
 * counted as ink above and then shields an 8px halo of the fainter trail around it.
 *
 * With this on, a medium-grey pixel counts as ink ONLY when the cross-page flat
 * field says it is content: it is genuinely DARK (< BG_HARD_INK ⇒ real ink), OR it
 * sits at a flat-BRIGHT location (white on some page ⇒ unique content of any
 * intensity). A PERSISTENT medium-grey pixel (flat not bright) is watermark by
 * cross-page consensus, so it no longer self-protects and the empty-background trail
 * around it clears. This is diagram/formula-safe BY CONSTRUCTION:
 *   • a unique diagram/formula stroke of ANY intensity keeps its bright flat ⇒ still
 *     seeds the protective halo AND is kept by the flat-bright guard below;
 *   • genuinely dark ink (< BG_HARD_INK) still seeds the halo;
 *   • watermark TOUCHING content is kept because the CONTENT seeds the halo around it.
 * Only persistent medium-grey in genuinely empty space (no dark ink and no unique
 * content within BG_HALO) loses protection. Validate on the Q108 page before enabling. */
export const backgroundTrailEnabled = (): boolean =>
  process.env.OCR_DISPLAY_BG_TRAIL === 'true';
/** Below this luma a pixel is real ink regardless of the flat field (TRAIL mode). */
const BG_HARD_INK = Number(process.env.OCR_DISPLAY_BG_HARD_INK ?? 110);

/** Pass 3 — remove the two-column page DIVIDER line, but ONLY where it is a
 *  PERSISTENT (cross-page) line that is horizontally ISOLATED (no ink beside it).
 *  A unique content line (formula bracket, graph axis, table rule) is white on
 *  other pages → flat bright → never removed. */
export const dividerCleanupEnabled = (): boolean =>
  process.env.OCR_DISPLAY_DIVIDER_CLEANUP !== 'false';
const DIV_DARK = Number(process.env.OCR_DISPLAY_DIV_DARK ?? 150);
/** A column must be dark over at least this fraction of the crop height to be a
 *  line candidate (text columns have gaps and never reach this). */
const DIV_COVERAGE = Number(process.env.OCR_DISPLAY_DIV_COVERAGE ?? 0.6);
/** A line pixel is removed only if no other ink lies within this many px to either
 *  side at that row (so the line is in a blank band, not beside text). */
const DIV_ISOLATE = Math.max(2, Math.round(Number(process.env.OCR_DISPLAY_DIV_ISOLATE ?? 10)));

/** Binary dilation by Chebyshev radius `r` (separable horizontal then vertical
 *  running-OR). Marks every pixel within `r` of a set pixel. */
const dilate = (mask: Uint8Array, w: number, h: number, r: number): Uint8Array => {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) {
      let v = 0;
      for (let dx = -r; dx <= r && !v; dx += 1) {
        const xx = x + dx;
        if (xx >= 0 && xx < w && mask[row + xx]) v = 1;
      }
      tmp[row + x] = v;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) {
      let v = 0;
      for (let dy = -r; dy <= r && !v; dy += 1) {
        const yy = y + dy;
        if (yy >= 0 && yy < h && tmp[yy * w + x]) v = 1;
      }
      out[y * w + x] = v;
    }
  }
  return out;
};

/** Resample a (low-res, page-sized) field — flat field OR watermark mask — to the
 *  crop's region at the crop's pixel resolution, so field[i] aligns 1:1 with crop
 *  pixel i. Both FlatField and WatermarkMask share this {width,height,data} shape. */
const flatForRegion = async (
  flat: { width: number; height: number; data: Uint8Array },
  region: { x0: number; y0: number; x1: number; y1: number },
  pageWidth: number,
  pageHeight: number,
  cropWidth: number,
  cropHeight: number,
): Promise<Uint8Array> => {
  const sx = flat.width / pageWidth;
  const sy = flat.height / pageHeight;
  const fx0 = Math.max(0, Math.floor(region.x0 * sx));
  const fy0 = Math.max(0, Math.floor(region.y0 * sy));
  const fx1 = Math.min(flat.width, Math.ceil(region.x1 * sx));
  const fy1 = Math.min(flat.height, Math.ceil(region.y1 * sy));
  const fw = Math.max(1, fx1 - fx0);
  const fh = Math.max(1, fy1 - fy0);
  const sub = Buffer.alloc(fw * fh);
  for (let y = 0; y < fh; y += 1) {
    const srcRow = (fy0 + y) * flat.width + fx0;
    sub.set(flat.data.subarray(srcRow, srcRow + fw), y * fw);
  }
  const { data: resized, info } = await sharp(sub, { raw: { width: fw, height: fh, channels: 1 } })
    .resize(cropWidth, cropHeight, { fit: 'fill' })
    .toColourspace('b-w') // force single channel — resize can promote to 3 (sRGB)
    .raw()
    .toBuffer({ resolveWithObject: true });
  // Defensive: if a build still returns multiple channels, take channel 0 so the
  // result aligns 1:1 with crop pixel `i` (else the gate/guards read interleaved
  // garbage — a silent no-op like the one this guards against).
  const chans = info.channels;
  if (chans === 1) return new Uint8Array(resized.buffer, resized.byteOffset, resized.length);
  const out = new Uint8Array(cropWidth * cropHeight);
  for (let p = 0; p < out.length; p += 1) out[p] = resized[p * chans];
  return out;
};

/**
 * Return a display-cleaned copy of `crop` (same dimensions/content; watermark
 * partially faded). Returns the ORIGINAL buffer unchanged on disable, on a
 * missing flat field (no cross-page consensus → unsafe to remove anything), or
 * on any error — cleanup is best-effort and must never break or hole the crop.
 */
export const cleanCropForDisplay = async (
  crop: Buffer,
  opts: {
    flat?: FlatField | null;
    /** Page-level large-watermark mask. When present, a pixel may be whitened ONLY
     *  if it is inside this mask — the structural guarantee that thin lines / small
     *  labels (never in a large blob) are kept. Absent ⇒ flat-field guards only. */
    mask?: WatermarkMask | null;
    region?: { x0: number; y0: number; x1: number; y1: number };
    pageWidth?: number;
    pageHeight?: number;
  } = {},
): Promise<Buffer> => {
  if (!displayCleanupEnabled()) return crop;
  const { flat, mask, region, pageWidth, pageHeight } = opts;
  // Content-first: with no cross-page consensus we cannot tell a light diagram
  // stroke from a light watermark, so we keep everything (watermark stays).
  if (!flat || !region || !pageWidth || !pageHeight) return crop;
  try {
    const { data, info } = await sharp(crop).raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    if (!width || !height) return crop;
    const n = width * height;

    // Luminance + dark-core mask → dilate to the protected set (C).
    const luma = new Float32Array(n);
    const core = new Uint8Array(n);
    for (let i = 0, p = 0; p < n; p += 1, i += channels) {
      const r = data[i];
      const g = channels >= 3 ? data[i + 1] : r;
      const b = channels >= 3 ? data[i + 2] : r;
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      luma[p] = L;
      if (L < CORE_DARK) core[p] = 1;
    }
    const protectedSet = dilate(core, width, height, HALO);
    const f = await flatForRegion(flat, region, pageWidth, pageHeight, width, height);
    // (A) Page-level large-watermark gate: resampled mask, 1 = inside a large
    // persistent watermark blob. Outside it (thin lines, small labels, codes,
    // unique content) → never whitened. Absent → no gate (flat-field guards only).
    const mreg = mask
      ? await flatForRegion(mask, region, pageWidth, pageHeight, width, height)
      : null;

    // When ON, drop the flat-BLIND dark guards (C)/(F) inside the mask so dark
    // watermark cores can be removed; the flat-AWARE guards (D)/(E) below still
    // protect all real content. Default OFF ⇒ guards apply ⇒ output unchanged.
    const persistentCore = persistentCoreEnabled();
    for (let i = 0, p = 0; p < n; p += 1, i += channels) {
      // (A) the large-watermark mask gates EVERYTHING — outside it, keep verbatim.
      if (mreg && mreg[p] < 128) continue;
      // Flat-AWARE content protections — these always hold (they ARE the cross-page
      // signal that separates content from watermark), so they run first.
      const F = f[p];
      if (F >= PROTECT_ABOVE) continue; // (E) content-capable location (white on some page) → keep
      const L = luma[p];
      if (L < F - KEEP_MARGIN) continue; // (D) darker than persistent background → content on top → keep
      // Flat-BLIND dark guards — kept by default; dropped in persistent-core mode,
      // where (D)/(E) above have already let through ONLY persistent (watermark)
      // darkness, so a dark pixel here is a confident watermark core.
      if (!persistentCore) {
        if (protectedSet[p]) continue; // (C) dark content + halo → keep verbatim
        if (L < WHITE_FLOOR) continue; // (F) absolute content floor → keep verbatim
      }

      // Confident watermark on NON-content → remove fully to white. BINARY: this is
      // the ONLY write; kept pixels above are never touched, so content is byte-faithful.
      data[i] = 255;
      if (channels >= 3) {
        data[i + 1] = 255;
        data[i + 2] = 255;
      }
    }

    // ---- PASS 2: faint background trails/fragments outside the mask ----
    // Whiten only LIGHT, PERSISTENT pixels that are FAR from any real ink. Never
    // touches dark ink or its halo (text/diagram edges) and never touches a
    // content-capable (flat-bright) location. `luma`/`f` are from the ORIGINAL crop.
    if (backgroundCleanupEnabled()) {
      const trail = backgroundTrailEnabled();
      const ink = new Uint8Array(n);
      for (let p = 0; p < n; p += 1) {
        if (luma[p] >= BG_INK_DARK) continue;
        // DEFAULT: anything below BG_INK_DARK is ink (and self-protects). TRAIL mode:
        // a MEDIUM-grey pixel is ink only if the flat field says it is content — it
        // is genuinely dark OR at a flat-bright (unique) location; a persistent
        // medium grey is a watermark trail, so it no longer shields a halo.
        if (trail && luma[p] >= BG_HARD_INK && f[p] < PROTECT_ABOVE) continue;
        ink[p] = 1;
      }
      const inkRegion = dilate(ink, width, height, BG_HALO);
      for (let i = 0, p = 0; p < n; p += 1, i += channels) {
        if (inkRegion[p]) continue; // near real ink → keep (protects text/diagram edges)
        const F = f[p];
        if (F >= PROTECT_ABOVE) continue; // content-capable location → keep (unique content)
        const L = luma[p];
        if (L < F - KEEP_MARGIN) continue; // darker than persistent bg → content over watermark → keep
        // light + persistent + far from ink → a background remnant → whiten.
        data[i] = 255;
        if (channels >= 3) {
          data[i + 1] = 255;
          data[i + 2] = 255;
        }
      }
    }

    // ---- PASS 3: persistent, isolated two-column divider line ----
    // Removes a near-full-height dark vertical line ONLY where it is PERSISTENT
    // (flat not bright → present across pages → layout chrome, not unique content)
    // AND horizontally ISOLATED (no ink beside it → a blank band, not next to text).
    if (dividerCleanupEnabled()) {
      for (let x = 0; x < width; x += 1) {
        let darkRows = 0;
        for (let y = 0; y < height; y += 1) if (luma[y * width + x] < DIV_DARK) darkRows += 1;
        if (darkRows < DIV_COVERAGE * height) continue; // not a vertical line
        for (let y = 0; y < height; y += 1) {
          const p = y * width + x;
          if (luma[p] >= DIV_DARK) continue; // not a line pixel at this row
          if (f[p] >= PROTECT_ABOVE) continue; // unique (content) line → keep (KEY safety)
          if (luma[p] < f[p] - KEEP_MARGIN) continue; // darker than persistent bg → content drawn here → keep
          let adjacent = false;
          for (let dx = -DIV_ISOLATE; dx <= DIV_ISOLATE && !adjacent; dx += 1) {
            if (Math.abs(dx) <= 1) continue; // skip the line column itself
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            if (luma[y * width + xx] < DIV_DARK) adjacent = true;
          }
          if (adjacent) continue; // ink beside the line at this row → keep (text-adjacent)
          const i = p * channels;
          data[i] = 255;
          if (channels >= 3) {
            data[i + 1] = 255;
            data[i + 2] = 255;
          }
        }
      }
    }
    return await sharp(data, { raw: { width, height, channels } }).png().toBuffer();
  } catch {
    return crop; // never break or hole the crop
  }
};
