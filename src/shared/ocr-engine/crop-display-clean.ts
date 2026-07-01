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

/**
 * BACKGROUND REMOVAL MASTER SWITCH — PERMANENTLY OFF (architecture decision 2026-06-24).
 *
 * The client pre-cleans every PDF externally, and the AGGRESSIVE background passes (cross-page
 * flat-field watermark suppression, near-white background lift, generic illumination flatten, column-
 * divider / horizontal-separator cleaning, persistent-/whole-object watermark removal) were a recurring
 * source of CONTENT LOSS — faint diagram strokes, grey chemistry fills and light formulas were
 * occasionally whitened. These FULL-PIXEL / background passes stay OFF: raw pixels, content never
 * modified. Set OCR_BACKGROUND_REMOVAL=1/true/on ONLY to re-enable them for debugging.
 *
 * NOTE: this does NOT govern HEADER/FOOTER/BORDER chrome removal — that is a SEPARATE, content-safe
 * pass (`pageChromeRemovalEnabled`, default ON) that erases only REPEATED page-level chrome and keeps
 * pixels wherever it overlaps content. See the user decision 2026-06-24: "header/footer/border removal
 * ON, background removal OFF, preserve content safety over cleanliness."
 */
export const backgroundRemovalEnabled = (): boolean =>
  /^(1|true|yes|on)$/i.test(process.env.OCR_BACKGROUND_REMOVAL ?? '');

/**
 * PAGE-CHROME (header / footer / border / repeated page artifact) REMOVAL — content-safe, DEFAULT ON.
 *
 * Distinct from background removal. This governs ONLY the deterministic, connected-component chrome
 * eraser (`removeChromeComponents`) which removes page chrome that is PROVEN repeated across pages
 * (institute headers like "SK LEARNINGS", footers, page-border rules, corner logos, isolated page
 * codes like CC-315) under a strict 3-condition gate: (1) persistent across pages, (2) outside the
 * reading-order text rows, (3) not touching any OCR word box. It erases the FULL component footprint
 * (no trails / ghosts) but can ONLY remove a component that satisfies ALL three — so a header/border
 * that overlaps question content, a diagram, an equation, a chemical structure or an option is KEPT
 * (content safety over cleanliness). It NEVER does background/illumination/watermark-consensus pixel
 * subtraction. Disable with OCR_PAGE_CHROME_REMOVAL=0/false/off (then crops keep the raw header/footer).
 */
export const pageChromeRemovalEnabled = (): boolean =>
  !/^(0|false|no|off)$/i.test(process.env.OCR_PAGE_CHROME_REMOVAL ?? '');

export const displayCleanupEnabled = (): boolean =>
  backgroundRemovalEnabled() && process.env.OCR_DISPLAY_WATERMARK_CLEANUP !== 'false';

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
 * FLAT-AWARE dark-core removal. DEFAULT ON — set OCR_DISPLAY_WM_PERSISTENT_CORE=false
 * to disable. It removes the dark watermark logo / diagonal text that survives the
 * mask pass. Only ever ACTIVE inside the large-watermark mask (see the `&& !!mreg`
 * gate at the call site): with no cross-page mask there is no consensus, so the
 * conservative absolute dark guards are kept.
 *
 * The dark-core guards (C) CORE_DARK and (F) WHITE_FLOOR are ABSOLUTE — they keep
 * ANY dark pixel, so a solid/dark watermark stroke (which is just as dark as ink)
 * is always protected. But the flat field already knows which dark pixels are
 * watermark: a pixel that is dark on THIS page AND whose flat field is ALSO dark
 * there is dark on EVERY page ⇒ persistent ⇒ the watermark itself; a dark pixel
 * whose flat is bright is unique ⇒ content. Inside the large mask the (C)/(F)
 * absolute guards are dropped and a dark pixel is whitened ONLY when the flat
 * confirms the darkness is persistent:
 *    • (E) still protects unique-content locations  (flat bright ⇒ kept), and
 *    • (D) still protects content drawn OVER the watermark (darker than the
 *          persistent background by KEEP_MARGIN ⇒ kept).
 * So it removes watermark cores WITHOUT the content loss a flat-blind threshold
 * would cause (a diagram stroke unique to the page has a bright flat and survives
 * via (E); a formula crossing the banner is darker-than-bg and survives via (D)).
 * VALIDATED on the real RE NEET PST paper: +81,984 watermark px removed, 0 content
 * pixels affected (flat-bright/darker-than-bg/outside-mask all 0), OCR output
 * byte-identical (180/180, coverage 99%, 0 per-draft field diffs). See
 * docs/WATERMARK_DISPLAY_CLEANUP.md. */
export const persistentCoreEnabled = (): boolean =>
  backgroundRemovalEnabled() && process.env.OCR_DISPLAY_WM_PERSISTENT_CORE !== 'false';

/** WHOLE-OBJECT watermark removal — OPT-IN (default OFF until validated). Set
 *  OCR_DISPLAY_WM_WHOLE_OBJECT=true to enable. Decides remove-WHOLE vs keep-WHOLE per
 *  connected watermark object (registration-tolerant) so one word is never left half
 *  cleaned. When OFF, the validated per-pixel mask pass runs unchanged. */
export const wholeObjectEnabled = (): boolean =>
  backgroundRemovalEnabled() && process.env.OCR_DISPLAY_WM_WHOLE_OBJECT === 'true';

// ---------------------------------------------------------------------------
// CONSERVATIVE BACKGROUND POST-PASSES (additive; run AFTER the mask pass above).
// They only ever set pixels to white, never darken, and are guarded so they
// cannot touch question text/options/formulas/diagrams. Both are reversible via
// env. They do NOT change the mask pass — disabling them restores prior output.
// ---------------------------------------------------------------------------

/** Pass 2 — remove faint watermark TRAILS / fragments that survived OUTSIDE the
 *  large-watermark mask, but ONLY in background far from any real ink. */
export const backgroundCleanupEnabled = (): boolean =>
  backgroundRemovalEnabled() && process.env.OCR_DISPLAY_BG_CLEANUP !== 'false';
/** Any pixel this dark counts as real INK (text/diagram/formula/table/divider).
 *  Pass 2 protects a halo around all of it and never whitens it. */
const BG_INK_DARK = Number(process.env.OCR_DISPLAY_BG_INK_DARK ?? 150);
/** Protect this many px around every ink pixel (covers anti-alias edges). */
const BG_HALO = Math.max(0, Math.round(Number(process.env.OCR_DISPLAY_BG_HALO ?? 8)));

/**
 * TRAIL mode. DEFAULT ON — set OCR_DISPLAY_BG_TRAIL=false to disable. Targets the
 * faint trail that survives Pass 2 in EMPTY background. It survives because a
 * MEDIUM-grey trail pixel (luma in [BG_HARD_INK, BG_INK_DARK)) is itself counted as
 * ink above and then shields an 8px halo of the fainter trail around it.
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
 * content within BG_HALO) loses protection. VALIDATED on the real RE NEET PST paper:
 * 9,972 background px removed, 0 content pixels affected. See
 * docs/WATERMARK_DISPLAY_CLEANUP.md. */
export const backgroundTrailEnabled = (): boolean =>
  backgroundRemovalEnabled() && process.env.OCR_DISPLAY_BG_TRAIL !== 'false';
/** Below this luma a pixel is real ink regardless of the flat field (TRAIL mode). */
const BG_HARD_INK = Number(process.env.OCR_DISPLAY_BG_HARD_INK ?? 110);

/** Pass 3 — remove the two-column page DIVIDER line as ONE WHOLE OBJECT. Everything
 *  (dark level, span, thickness, confidence) is derived from THIS document — no fixed
 *  threshold, no per-PDF env tuning (see `removeColumnDividers`). Default ON; set
 *  OCR_DISPLAY_DIVIDER_CLEANUP=false to disable. */
export const dividerCleanupEnabled = (): boolean =>
  backgroundRemovalEnabled() && process.env.OCR_DISPLAY_DIVIDER_CLEANUP !== 'false';

/** Pass 4 — the HORIZONTAL equivalent of Pass 3: remove the PDF page-end separator /
 *  footer rule, but ONLY where it is a PERSISTENT (cross-page) horizontal line that is
 *  vertically ISOLATED (no ink above/below → a blank band, not a table/option border).
 *  A unique content rule (table border, graph axis, option underline, match-the-column
 *  grid) is white on other pages → flat bright → never removed. DEFAULT ON — set
 *  OCR_DISPLAY_HSEP_CLEANUP=false to disable. VALIDATED on RE NEET PST 3 (5/5 genuine
 *  separators removed, tables/diagrams/options intact) and a second template (0 content
 *  damage), with OCR output byte-identical. See docs/WATERMARK_DISPLAY_CLEANUP.md. */
export const hsepCleanupEnabled = (): boolean =>
  backgroundRemovalEnabled() && process.env.OCR_DISPLAY_HSEP_CLEANUP !== 'false';
const HSEP_DARK = Number(process.env.OCR_DISPLAY_HSEP_DARK ?? 150);
/** A row must be dark over at least this fraction of the crop WIDTH to be a line
 *  candidate (text rows have gaps and never reach this). */
const HSEP_COVERAGE = Number(process.env.OCR_DISPLAY_HSEP_COVERAGE ?? 0.6);
/** A line pixel is removed only if no other ink lies within this many px ABOVE or
 *  BELOW at that column (so the line is in a blank band, not part of a table/option). */
const HSEP_ISOLATE = Math.max(2, Math.round(Number(process.env.OCR_DISPLAY_HSEP_ISOLATE ?? 10)));
/** PERSISTENCE is tested at ROW level, not per pixel: a thin 2px rule is averaged to
 *  grey in the low-res flat field, so the per-pixel "darker-than-bg" test (Pass 3)
 *  wrongly keeps it. Instead we require the FLAT FIELD to DIP at the line row vs a few
 *  px above/below — i.e. a persistent horizontal dark band across pages. Bright flat
 *  (unique content: table border / graph axis) shows no dip and is kept. */
const HSEP_FLAT_GAP = Math.max(2, Math.round(Number(process.env.OCR_DISPLAY_HSEP_FLAT_GAP ?? 6)));
const HSEP_DIP = Number(process.env.OCR_DISPLAY_HSEP_DIP ?? 14);

/** Binary dilation by Chebyshev radius `r` (separable horizontal then vertical).
 *  Marks every pixel within `r` of a set pixel.
 *
 *  PERF (P3.1): a SLIDING-WINDOW set-count makes each axis O(1) per pixel instead of
 *  O(r) — byte-IDENTICAL output (a pixel is set iff any source pixel within ±r on that
 *  axis is set; the count is >0 in exactly the same cases the old inner loop found a 1).
 *  This is the dominant cost of the page-level consensus pass; the speedup is pure and
 *  changes no visual output. (Down-scaling the decision was rejected: it would alter
 *  whitened pixels and risk faint content — this keeps the result exact.) */
const dilate = (mask: Uint8Array, w: number, h: number, r: number): Uint8Array => {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    let count = 0;
    for (let x = 0; x <= r && x < w; x += 1) count += mask[row + x]; // window [0, r] for x=0
    for (let x = 0; x < w; x += 1) {
      tmp[row + x] = count > 0 ? 1 : 0;
      const add = x + r + 1; // entering the window as it slides to x+1
      if (add < w) count += mask[row + add];
      const rem = x - r; // leaving the window
      if (rem >= 0) count -= mask[row + rem];
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x += 1) {
    let count = 0;
    for (let y = 0; y <= r && y < h; y += 1) count += tmp[y * w + x];
    for (let y = 0; y < h; y += 1) {
      out[y * w + x] = count > 0 ? 1 : 0;
      const add = y + r + 1;
      if (add < h) count += tmp[add * w + x];
      const rem = y - r;
      if (rem >= 0) count -= tmp[rem * w + x];
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
 * COLUMN-DIVIDER removal — ONE implementation, identical in EVERY upload mode.
 *
 * The divider (the "|" between two columns) is removed as ONE whole object, the same way for a
 * single page, a partial PDF, or a full PDF. The SOURCE OF TRUTH is the ACTUAL PAGE the divider
 * is on — its own geometry at full render resolution — never the low-resolution cross-page flat
 * field. (That was the production bug: the flat field is the per-pixel BRIGHTEST across pages
 * down-sampled to ~700px; sub-pixel registration jitter + the MAX brightens a thin divider away,
 * so flat-based detection found nothing on real PDFs even though the line is plainly there. The
 * REAL page always carries the sharp, full-resolution line.) Detecting on the page is also
 * consistent across a full PDF: the divider is the same column with the same clean gutters on
 * every page, so every page detects and removes the same line; a page that physically has no
 * divider in some band (e.g. a title/header region) correctly removes nothing there.
 *
 * The divider is defined purely by geometry the PDF determines itself (no coordinate, no fixed
 * size, no env): a THIN, near-FULL-HEIGHT, near-CONTINUOUS vertical dark run sitting in a clean
 * WHITESPACE gutter on BOTH sides. A graph axis / table border / figure boundary / chemical bond
 * / match-the-following connector has content on at least one side (or is not long) ⇒ it FAILS
 * the gutter/length test ⇒ it is KEPT. Removal is whole-object: a band is removed entirely or
 * kept entirely, never half.
 */
interface DividerBand {
  x0f: number; // band left  as a fraction of page width
  x1f: number; // band right as a fraction of page width
  y0f: number; // run top    as a fraction of page height
  y1f: number; // run bottom as a fraction of page height
}

/** 95th-percentile value of a field — its "paper white" level. Lets dark/bright thresholds be
 *  derived from the page's own histogram (adapts to exposure/scan; no fixed value, no env). */
const percentile = (field: ArrayLike<number>, q: number): number => {
  const hist = new Uint32Array(256);
  for (let i = 0; i < field.length; i += 1) {
    let v = field[i] | 0;
    if (v < 0) v = 0;
    else if (v > 255) v = 255;
    hist[v] += 1;
  }
  const target = field.length * q;
  let acc = 0;
  for (let v = 0; v < 256; v += 1) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
};

/**
 * Locate the divider band(s) in the page's greyscale `field`. `markThr` is the dark-CONTENT
 * cutoff (derived from the page histogram): below it a pixel is real ink (divider, text, plot,
 * table rule). It is deliberately well BELOW any faint watermark/background grey, so a watermark
 * that pervades the gutter does NOT count as content — that was the production failure (a real
 * NEET page has a ~7% watermark fill in the gutter that a brightness test wrongly read as ink).
 * Returns bands as page fractions.
 */
const computeDividerBands = (
  field: ArrayLike<number>,
  w: number,
  h: number,
  markThr: number,
): DividerBand[] => {
  const out: DividerBand[] = [];
  if (w < 8 || h < 16) return out;
  const marked = (x: number, y: number): boolean => field[y * w + x] < markThr;

  // "Long" = at least a THIRD of the page height (a header/footer can shorten a real divider, so
  // a strict half is too tight). Tiny anti-alias drop-outs are bridged so the line stays ONE run.
  const minRun = Math.round(h * 0.33);
  const gapTol = Math.max(2, Math.round(h * 0.02));

  const runLen = new Int32Array(w);
  const rTop = new Int32Array(w);
  const rBot = new Int32Array(w);
  for (let x = 0; x < w; x += 1) {
    let bestLen = 0;
    let bestTop = 0;
    let bestBot = -1;
    let curTop = -1;
    let curBot = -1;
    let gap = 0;
    for (let y = 0; y < h; y += 1) {
      if (marked(x, y)) {
        if (curTop < 0) curTop = y;
        curBot = y;
        gap = 0;
      } else if (curTop >= 0) {
        gap += 1;
        if (gap > gapTol) {
          if (curBot - curTop + 1 > bestLen) {
            bestLen = curBot - curTop + 1;
            bestTop = curTop;
            bestBot = curBot;
          }
          curTop = -1;
          gap = 0;
        }
      }
    }
    if (curTop >= 0 && curBot - curTop + 1 > bestLen) {
      bestLen = curBot - curTop + 1;
      bestTop = curTop;
      bestBot = curBot;
    }
    runLen[x] = bestLen;
    rTop[x] = bestTop;
    rBot[x] = bestBot;
  }
  const isLine = (x: number): boolean => runLen[x] >= minRun;

  const maxThick = Math.max(3, Math.round(w * 0.02)); // a divider is THIN (hairline, not a block)
  const clear = Math.max(4, Math.round(w * 0.015)); // gutter probe reach each side

  for (let xs = 0; xs < w; ) {
    if (!isLine(xs)) {
      xs += 1;
      continue;
    }
    let xe = xs;
    while (xe + 1 < w && isLine(xe + 1)) xe += 1;
    const thickness = xe - xs + 1;
    let vtop = h;
    let vbot = -1;
    for (let x = xs; x <= xe; x += 1) {
      if (rTop[x] < vtop) vtop = rTop[x];
      if (rBot[x] > vbot) vbot = rBot[x];
    }

    const ok = ((): boolean => {
      if (thickness > maxThick) return false; // a block / panel, not a hairline divider
      // Need a verifiable gutter on BOTH sides ⇒ INTERIOR only. Also skips page-frame border
      // rules at the very edge (no outer gutter to confirm) — we target the middle divider.
      if (xs - 1 - clear < 0 || xe + 1 + clear >= w) return false;
      // CLEAR WHITESPACE GUTTERS ON BOTH SIDES — just outside the band, along its whole run, there
      // must be almost no dark CONTENT. A watermark/background grey does not count (it is above
      // markThr); real content (table cell, graph plot, diagram, match connector, figure edge) IS
      // dark ⇒ it makes a side non-clean ⇒ NOT an isolated divider ⇒ keep the whole thing.
      const gutterInk = (a: number, b: number): number => {
        let nb = 0;
        let tot = 0;
        for (let y = vtop; y <= vbot; y += 1)
          for (let x = a; x <= b; x += 1) {
            tot += 1;
            if (field[y * w + x] < markThr) nb += 1;
          }
        return tot ? nb / tot : 1;
      };
      if (gutterInk(xs - 1 - clear, xs - 2) > 0.04) return false; // "mostly whitespace" — tolerate a little
      if (gutterInk(xe + 2, xe + 1 + clear) > 0.04) return false;
      return true;
    })();

    if (ok) out.push({ x0f: xs / w, x1f: (xe + 1) / w, y0f: vtop / h, y1f: (vbot + 1) / h });
    xs = xe + 1;
  }
  return out;
};

/**
 * Remove the column divider from a full page image — the SINGLE entry point, used in every
 * upload mode and on every page-source (the engine display page AND the delivery re-crop page).
 * Detection is on the page's OWN full-resolution geometry, so it works on real uploads where the
 * low-res flat field cannot see the thin line. `opts.flat` is accepted for signature stability
 * but is intentionally NOT used to locate the divider (it brightens thin lines away). Best-
 * effort: returns the input unchanged when disabled, when no divider is found, or on any error.
 * DISPLAY-ONLY: it rewrites page pixels that become a crop source; never feeds OCR, never a draft.
 */
export const removeColumnDivider = async (
  image: Buffer,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  opts: { flat?: FlatField | null; pageWidth?: number; pageHeight?: number } = {},
): Promise<Buffer> => {
  if (!dividerCleanupEnabled()) return image;
  try {
    const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    if (!width || !height) return image;
    const n = width * height;
    const luma = new Float32Array(n);
    for (let i = 0, p = 0; p < n; p += 1, i += channels) {
      const r = data[i];
      const g = channels >= 3 ? data[i + 1] : r;
      const b = channels >= 3 ? data[i + 2] : r;
      luma[p] = 0.299 * r + 0.587 * g + 0.114 * b;
    }

    // Derive the page's own dark-content cutoff from its histogram (no fixed value, no env), then
    // run the ONE detector on the page's real geometry — the same in every upload mode. markThr is
    // 0.6× the paper level, so it sits below any faint watermark/background grey (content-only).
    const paper = percentile(luma, 0.95);
    const markThr = Math.max(80, Math.min(200, paper * 0.6));
    const bands = computeDividerBands(luma, width, height, markThr);
    if (!bands.length) return image;

    const pad = Math.max(1, Math.round(width * 0.004)); // tiny; stays inside the gutter
    let touched = false;
    for (const band of bands) {
      const lx0 = Math.max(0, Math.floor(band.x0f * width) - pad);
      const lx1 = Math.min(width - 1, Math.ceil(band.x1f * width) + pad);
      const ly0 = Math.max(0, Math.floor(band.y0f * height));
      const ly1 = Math.min(height - 1, Math.ceil(band.y1f * height));
      for (let y = ly0; y <= ly1; y += 1) {
        const row = y * width;
        for (let x = lx0; x <= lx1; x += 1) {
          const i = (row + x) * channels;
          data[i] = 255;
          if (channels >= 3) {
            data[i + 1] = 255;
            data[i + 2] = 255;
          }
          touched = true;
        }
      }
    }
    if (!touched) return image;
    return await sharp(data, { raw: { width, height, channels } }).png().toBuffer();
  } catch {
    return image; // never break or hole the page
  }
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

    // Drop the flat-BLIND dark guards (C)/(F) inside the mask so dark watermark
    // cores can be removed; the flat-AWARE guards (D)/(E) below still protect all
    // real content. GATED to `mreg` (a real large-watermark mask): without cross-page
    // consensus there is no large-watermark mask, so the conservative absolute dark
    // guards stay — persistentCore never acts on a maskless crop.
    const persistentCore = persistentCoreEnabled() && mreg != null;
    // Whole-object removal runs on cross-page CONSENSUS (the flat field is always present in this
    // function), NOT on the size-filtered large-watermark mask — a faint OUTLINE watermark never
    // forms a large blob, so it has no `mreg`, yet it is exactly what must be removed as one object.
    if (wholeObjectEnabled()) {
      // ───────────────── WHOLE-OBJECT watermark removal (opt-in) ─────────────────
      // Golden rule: a watermark is ONE connected object — remove ALL of it or keep ALL
      // of it, never half. Steps (registration-tolerant, value-free):
      //   1. Binarise the large-watermark mask and DILATE by `bridge` so the jittered
      //      strokes of a single word merge into ONE object (and a watermark sitting on
      //      real content merges WITH that content → it will be kept whole).
      //   2. Per object, measure the CROSS-PAGE UNIQUE-DARK-INK fraction: pixels that are
      //      dark on THIS page (luma < CORE_DARK) AND whose flat field is BRIGHT (white on
      //      some page ⇒ unique to this page ⇒ real content drawn over the watermark). A
      //      persistent watermark — even a dark one — has flat NOT bright, so it does NOT
      //      count; registration jitter only adds a thin halo, so it stays a small fraction.
      //   3. DECIDE: fraction ≥ τ ⇒ CONTENT OVERLAP ⇒ keep the WHOLE object (banner-over-
      //      formula becomes keep-whole automatically; uncertain biases here). Else PURE
      //      watermark ⇒ whiten the WHOLE object coherently (no per-pixel flat-bright gaps).
      //   4. BACKSTOP: even in a pure object, a unique-dark-ink pixel is NEVER whitened, so
      //      content can never be cut even if an object were mis-classified.
      const bridge = Math.max(
        2,
        Math.round(Number(process.env.OCR_DISPLAY_WM_BRIDGE) || Math.min(width, height) * 0.02),
      );
      const tau = Math.min(0.9, Math.max(0.05, Number(process.env.OCR_DISPLAY_WM_CONTENT_FRAC) || 0.3));
      // A removal CANDIDATE must be WIDE — a watermark word/banner spans a large fraction of the
      // page width. This is the registration-tolerant size gate that replaces the per-pixel mask:
      // a small content mark (a label, a tiny symbol) is NEVER wide enough to qualify.
      const extentFrac = Math.min(0.9, Math.max(0.1, Number(process.env.OCR_DISPLAY_WM_EXTENT) || 0.25));
      const uniqueDark = (p: number): boolean => luma[p] < CORE_DARK && f[p] >= PROTECT_ABOVE;
      // OBJECT SEED = inked on THIS page AND persistent (flat NOT bright = present on every page).
      // A UNIQUE diagram/formula/text is flat-BRIGHT ⇒ NOT seeded ⇒ can never become a watermark
      // candidate (content is safe by construction). Only persistent ink (watermark / page chrome)
      // is seeded. Union the large-watermark mask so solid persistent blobs are always included.
      const seed = new Uint8Array(n);
      for (let p = 0; p < n; p += 1)
        seed[p] = (luma[p] < PROTECT_ABOVE && f[p] < PROTECT_ABOVE) || (mreg ? mreg[p] >= 128 : false) ? 1 : 0;
      const objects = dilate(seed, width, height, bridge);
      const label = new Int32Array(n);
      const inkCount: number[] = [0];
      const uniqCount: number[] = [0];
      const minX: number[] = [0];
      const maxX: number[] = [0];
      const stack: number[] = [];
      let id = 0;
      for (let s = 0; s < n; s += 1) {
        if (!objects[s] || label[s]) continue;
        id += 1;
        label[s] = id;
        let ink = 0;
        let uniq = 0;
        let mn = width;
        let mx = 0;
        stack.length = 0;
        stack.push(s);
        while (stack.length) {
          const q = stack.pop() as number;
          const x = q % width;
          if (luma[q] < PROTECT_ABOVE) {
            ink += 1; // any non-near-white pixel = ink (watermark or content)
            if (x < mn) mn = x;
            if (x > mx) mx = x;
          }
          if (uniqueDark(q)) uniq += 1; // unique dark ink = real content drawn over the watermark
          const y = (q / width) | 0;
          if (x > 0 && objects[q - 1] && !label[q - 1]) { label[q - 1] = id; stack.push(q - 1); }
          if (x < width - 1 && objects[q + 1] && !label[q + 1]) { label[q + 1] = id; stack.push(q + 1); }
          if (y > 0 && objects[q - width] && !label[q - width]) { label[q - width] = id; stack.push(q - width); }
          if (y < height - 1 && objects[q + width] && !label[q + width]) { label[q + width] = id; stack.push(q + width); }
        }
        inkCount[id] = ink;
        uniqCount[id] = uniq;
        minX[id] = mn;
        maxX[id] = mx;
      }
      for (let i = 0, p = 0; p < n; p += 1, i += channels) {
        if (!seed[p]) continue; // not persistent ink → keep verbatim (unique content lives here)
        const lid = label[p];
        const wide = maxX[lid] - minX[lid] + 1 >= extentFrac * width; // watermark word/banner extent
        if (!wide) continue; // small persistent mark (code/label) → not a confident watermark → keep
        const frac = inkCount[lid] > 0 ? uniqCount[lid] / inkCount[lid] : 0;
        if (frac >= tau) continue; // CONTENT OVERLAP (incl. uncertain) → keep the WHOLE object
        if (luma[p] >= PROTECT_ABOVE) continue; // near-white → nothing to remove
        if (uniqueDark(p)) continue; // BACKSTOP: unique dark ink ⇒ never cut content
        // WIDE, PURE watermark object ⇒ whiten its persistent ink (coherent whole-object removal).
        data[i] = 255;
        if (channels >= 3) {
          data[i + 1] = 255;
          data[i + 2] = 255;
        }
      }
    } else {
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

    // (The column-divider pass lives in `removeColumnDivider`, run once per page in
    // `cleanPageForDisplay` for EVERY upload mode — it is not gated on the flat field here.)

    // ---- PASS 4: persistent, isolated HORIZONTAL page-separator / footer line ----
    // The mirror of Pass 3 (rows ↔ columns). Removes a near-full-width dark horizontal
    // line ONLY where it is PERSISTENT (flat not bright → present at this page position
    // on every page → PDF chrome, not unique content) AND vertically ISOLATED (no ink
    // above/below → a blank band, not a table/option/graph border). Whitens in place;
    // never crops. A table border / graph axis / option underline is unique (flat
    // bright) AND adjacent to content → doubly protected.
    if (hsepCleanupEnabled()) {
      for (let y = 0; y < height; y += 1) {
        const row = y * width;
        let darkCols = 0;
        for (let x = 0; x < width; x += 1) if (luma[row + x] < HSEP_DARK) darkCols += 1;
        if (darkCols < HSEP_COVERAGE * width) continue; // not a full-width horizontal line

        // PERSISTENCE (cross-page): the flat field must DIP at this row vs a few px above
        // and below — a persistent dark band present on every page. Measured over the
        // line's own dark columns so a unique (flat-bright) rule shows no dip and is kept.
        const ya = Math.max(0, y - HSEP_FLAT_GAP) * width;
        const yb = Math.min(height - 1, y + HSEP_FLAT_GAP) * width;
        let fLine = 0;
        let fAround = 0;
        let cnt = 0;
        for (let x = 0; x < width; x += 1) {
          if (luma[row + x] >= HSEP_DARK) continue;
          fLine += f[row + x];
          fAround += (f[ya + x] + f[yb + x]) * 0.5;
          cnt += 1;
        }
        if (cnt === 0) continue;
        fLine /= cnt;
        fAround /= cnt;
        if (fLine >= PROTECT_ABOVE) continue; // flat bright at the line → unique content → keep
        if (fLine >= fAround - HSEP_DIP) continue; // no persistent dark band in the flat → keep

        // Confirmed persistent separator row — whiten its line pixels where vertically
        // ISOLATED (no ink above/below ⇒ a blank band, not a table/option/graph border).
        for (let x = 0; x < width; x += 1) {
          const p = row + x;
          if (luma[p] >= HSEP_DARK) continue;
          let adjacent = false;
          for (let dy = -HSEP_ISOLATE; dy <= HSEP_ISOLATE && !adjacent; dy += 1) {
            if (Math.abs(dy) <= 1) continue; // skip the line row itself
            const yy = y + dy;
            if (yy < 0 || yy >= height) continue;
            if (luma[yy * width + x] < HSEP_DARK) adjacent = true;
          }
          if (adjacent) continue; // ink above/below ⇒ content-adjacent ⇒ keep
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

/**
 * GENERIC WHITE-POINT BACKGROUND LIFT (DEMO BLOCKER #2). Project-agnostic, flat-field-free,
 * ALWAYS-ON background normalizer so background cleaning is CONSISTENT for ANY client paper —
 * including 1–2 page uploads that have no cross-page watermark consensus. It lifts ONLY NEAR-WHITE
 * pixels (grey paper texture, light scanning shadows, faint margin/stain noise) to pure white; every
 * pixel darker than the white-point — question/option text, graphs, diagrams, chemistry structures,
 * arrows, labels, equations, tables, thin lines — is left byte-for-byte untouched. Content-loss = 0
 * by construction (it can only brighten the lightest greys, never darken or remove ink). No PDF/
 * institute/subject names, no fixed coordinates/heights/page sizes. Disable via OCR_BG_LIFT=false;
 * tune the threshold with OCR_BG_WHITE_POINT (default 232 — conservative: ~90% clean, 0% loss).
 */
export const liftBackground = async (crop: Buffer): Promise<Buffer> => {
  if (!backgroundRemovalEnabled() || process.env.OCR_BG_LIFT === 'false') return crop;
  const WHITE_POINT = Math.min(254, Math.max(180, Number(process.env.OCR_BG_WHITE_POINT) || 232));
  try {
    const { data, info } = await sharp(crop).raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels;
    for (let i = 0; i < data.length; i += ch) {
      const r = data[i];
      const g = ch >= 3 ? data[i + 1] : data[i];
      const b = ch >= 3 ? data[i + 2] : data[i];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum >= WHITE_POINT) { data[i] = 255; if (ch >= 3) { data[i + 1] = 255; data[i + 2] = 255; } }
    }
    return await sharp(data, { raw: { width: info.width, height: info.height, channels: ch } }).png().toBuffer();
  } catch {
    return crop; // never break the crop
  }
};

/**
 * GENERIC ILLUMINATION FLATTENING — flat-field-FREE, single-page background removal that works on
 * ANY paper (incl. 1–2 page uploads with no cross-page consensus). It estimates the slowly-varying
 * page background (grey paper texture, scanning shadows, gradients, faint large tints) with a heavily
 * down-scaled + blurred copy, then removes ONLY the pixels that sit at (or above) that local
 * background — they are paper/shadow, so they go white.
 *
 * CONTENT SAFETY (BINARY — fixed). Every pixel is EITHER kept BYTE-FOR-BYTE or set to white; there is
 * NO proportional brightening. The previous version multiplied every pixel by 255/bg, which LIFTED
 * grey content toward white — it washed out grey-shaded diagram fills and strands (the tRNA cloverleaf
 * loops / mRNA bar damage). A pixel is now KEPT VERBATIM when it is meaningfully DARKER than its local
 * background (ink / stroke / diagram / table rule / grey fill), OR sits inside a dark filled region
 * (bg estimate itself dark). Only a pixel that is NOT darker than its local background by `NEAR` —
 * i.e. genuine background — is whitened. So grey diagram content (darker than the surrounding paper)
 * is never modified, while grey paper / shadows / tints (≈ their own local background) are removed.
 * No PDF/institute/subject logic, no fixed coordinates/heights/page sizes. Disable with OCR_PAGE_FLATTEN=false.
 */
export const flattenIllumination = async (page: Buffer): Promise<Buffer> => {
  if (!backgroundRemovalEnabled() || process.env.OCR_PAGE_FLATTEN === 'false') return page;
  const BG_MIN = Math.min(220, Math.max(80, Number(process.env.OCR_FLATTEN_BG_MIN) || 150)); // below ⇒ filled content ⇒ keep
  // A pixel darker than its local background by at least NEAR is content ⇒ kept verbatim. Smaller ⇒
  // more conservative (keeps fainter strokes). Default 16: protects grey diagram fills/strands.
  const NEAR = Math.min(60, Math.max(4, Number(process.env.OCR_FLATTEN_NEAR) || 16));
  try {
    const grey = sharp(page).greyscale();
    const { data: g, info } = await grey.clone().raw().toBuffer({ resolveWithObject: true });
    const W = info.width;
    const H = info.height;
    if (!W || !H) return page;
    // Background estimate: shrink → blur → grow back. Ink (high-frequency) is averaged out, leaving
    // the smooth illumination/texture surface. Cheap and resolution-independent.
    const small = Math.max(64, Math.min(320, Math.round(W / 4)));
    const bg = await grey.clone().resize(small, null, { fit: 'inside' }).blur(6).resize(W, H, { fit: 'fill' }).raw().toBuffer();
    const out = Buffer.allocUnsafe(W * H);
    for (let i = 0; i < W * H; i += 1) {
      const b = bg[i] || 1;
      const gi = g[i];
      if (b < BG_MIN) { out[i] = gi; continue; } // dark background = inside filled content ⇒ keep verbatim
      if (gi <= b - NEAR) { out[i] = gi; continue; } // darker than local bg ⇒ ink / stroke / grey fill ⇒ keep verbatim
      out[i] = 255; // at/above local background ⇒ paper / shadow / tint ⇒ white (the ONLY write)
    }
    return await sharp(out, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
  } catch {
    return page; // best-effort: never break the page
  }
};

/** Deterministic Chrome Removal toggle — default ON; OCR_DISPLAY_CC_CHROME=false to disable. */
/** DETERMINISTIC CHROME REMOVAL — gated by the content-safe PAGE-CHROME switch (default ON), NOT the
 *  background switch. This is the header/footer/border/repeated-artifact eraser the architecture keeps
 *  ON while background removal stays OFF. Set OCR_DISPLAY_CC_CHROME=false to disable just this pass. */
export const chromeRemovalEnabled = (): boolean =>
  pageChromeRemovalEnabled() && process.env.OCR_DISPLAY_CC_CHROME !== 'false';

/** Luma below this counts as INK for component DISCOVERY (generous — captures light-grey page
 *  codes / faded logo strokes). It is NOT a removal threshold: content is protected by the
 *  3-condition gate below, never by this cutoff. */
const CC_INK = Number(process.env.OCR_DISPLAY_CC_INK ?? 225);

interface ChromeWord {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * DETERMINISTIC CHROME REMOVAL (display-only; runs inside cleanPageForDisplay).
 *
 * Erases ISOLATED page chrome — institute page codes (C112 / C223 / CC-315), corner logos,
 * banners, page-border rules, margin noise, isolated watermark fragments — by connected-
 * component analysis. NO thresholding-as-removal, NO inpainting, NO hallucination, NO
 * blanket whitening. A connected component is whitened ONLY when ALL THREE conditions hold
 * (any one failing or uncertain ⇒ the component is KEPT byte-for-byte):
 *   (1) PERSISTENT across pages — the discovery mask only admits pixels whose flat field is
 *       non-bright (persistent). A unique diagram / graph / chemistry / table stroke is
 *       flat-BRIGHT ⇒ it never enters the mask ⇒ never forms a component ⇒ never erased.
 *   (2) OUTSIDE logical reading order — the component box does not sit on any OCR text line
 *       (a row band × that row's horizontal extent).
 *   (3) NOT TOUCHING any OCR word box (each word dilated by a margin).
 * A huge component (> 25% of the page) is also kept (safety). No flat field / no word boxes
 * ⇒ the whole pass is a NO-OP. This can change pixels ONLY in the displayed crop source;
 * it never feeds OCR and never changes any draft field ⇒ N=N / boundaries cannot move.
 */
const removeChromeComponents = async (
  detectPage: Buffer,
  erasePage: Buffer,
  flat: FlatField,
  words: ChromeWord[],
  pageWidth: number,
  pageHeight: number,
): Promise<Buffer> => {
  // Discover components on the ORIGINAL page (chrome is solid there) but erase their full
  // footprint on the CLEANED output — so a code/logo/banner that earlier passes only faded
  // is removed completely, with no ghost left behind.
  const { data, info } = await sharp(detectPage).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  if (!W || !H) return erasePage;
  const erase = await sharp(erasePage).raw().toBuffer({ resolveWithObject: true });
  const eData = erase.data;
  const eCh = erase.info.channels;
  if (erase.info.width !== W || erase.info.height !== H) return erasePage; // dims must align 1:1
  const n = W * H;

  // Word boxes are in OCR/page-image coordinates; scale to THIS image's pixels (usually 1:1).
  const sx = W / pageWidth;
  const sy = H / pageHeight;
  const sw = words.map((w) => ({ x0: w.x0 * sx, y0: w.y0 * sy, x1: w.x1 * sx, y1: w.y1 * sy }));
  const hs = sw.map((w) => w.y1 - w.y0).filter((h) => h > 0).sort((a, b) => a - b);
  const mh = hs.length ? Math.max(6, hs[hs.length >> 1]) : 12;
  const WORD_PAD = Math.round(mh * 0.6);

  // (3) dilated word mask. (2) reading-order row bands (words clustered by vertical overlap).
  const wordMask = new Uint8Array(n);
  for (const w of sw) {
    const x0 = Math.max(0, Math.floor(w.x0 - WORD_PAD));
    const x1 = Math.min(W - 1, Math.ceil(w.x1 + WORD_PAD));
    const y0 = Math.max(0, Math.floor(w.y0 - WORD_PAD));
    const y1 = Math.min(H - 1, Math.ceil(w.y1 + WORD_PAD));
    for (let y = y0; y <= y1; y += 1) {
      const r = y * W;
      for (let x = x0; x <= x1; x += 1) wordMask[r + x] = 1;
    }
  }
  const rows: Array<{ y0: number; y1: number; x0: number; x1: number }> = [];
  for (const w of [...sw].sort((a, b) => a.y0 - b.y0)) {
    const row = rows.find((r) => !(w.y1 < r.y0 || w.y0 > r.y1));
    if (row) {
      row.y0 = Math.min(row.y0, w.y0);
      row.y1 = Math.max(row.y1, w.y1);
      row.x0 = Math.min(row.x0, w.x0);
      row.x1 = Math.max(row.x1, w.x1);
    } else rows.push({ y0: w.y0, y1: w.y1, x0: w.x0, x1: w.x1 });
  }
  const inReadingOrder = (bx0: number, by0: number, bx1: number, by1: number): boolean =>
    rows.some((r) => !(by1 < r.y0 || by0 > r.y1) && !(bx1 < r.x0 || bx0 > r.x1));

  // (1) persistent-ink discovery mask: dark-ish AND flat non-bright (persistent across pages).
  const f = await flatForRegion(flat, { x0: 0, y0: 0, x1: pageWidth, y1: pageHeight }, pageWidth, pageHeight, W, H);
  const ink = new Uint8Array(n);
  for (let p = 0; p < n; p += 1) if (data[p] < CC_INK && f[p] < PROTECT_ABOVE) ink[p] = 1;

  // 8-connectivity CCL (iterative, over set pixels only) → per-component metadata.
  const label = new Int32Array(n); // 0 = unvisited; else component id
  const stack: number[] = [];
  // A LARGE persistent component is chrome by construction (unique content is flat-bright ⇒
  // excluded from `ink`), so the cap is only a backstop against a degenerate flat field; keep
  // it generous so real diagonal banners / big logos are erased, not skipped.
  const AREA_CAP = Math.round(0.45 * n);
  const erasable: boolean[] = [false]; // index 0 unused
  let id = 0;
  for (let s = 0; s < n; s += 1) {
    if (!ink[s] || label[s]) continue;
    id += 1;
    let cnt = 0;
    let minx = W;
    let miny = H;
    let maxx = 0;
    let maxy = 0;
    let touchesWord = false;
    stack.length = 0;
    stack.push(s);
    label[s] = id;
    while (stack.length) {
      const p = stack.pop() as number;
      cnt += 1;
      const x = p % W;
      const y = (p / W) | 0;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
      if (wordMask[p]) touchesWord = true;
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const q = yy * W + xx;
          if (ink[q] && !label[q]) {
            label[q] = id;
            stack.push(q);
          }
        }
      }
    }
    // 3-condition gate (else keep): persistent already holds (mask), so require not-touching
    // a word (3) AND outside reading order (2), and never erase a huge component.
    erasable[id] =
      cnt <= AREA_CAP && !touchesWord && !inReadingOrder(minx, miny, maxx, maxy);
  }

  // Single erase sweep — whiten (on the CLEANED buffer) only the pixels of components that
  // passed all conditions. The full component footprint is cleared, so faded ghosts go too.
  let erased = 0;
  for (let p = 0; p < n; p += 1) {
    const l = label[p];
    if (l && erasable[l]) {
      const i = p * eCh;
      eData[i] = 255;
      if (eCh >= 3) {
        eData[i + 1] = 255;
        eData[i + 2] = 255;
      }
      erased += 1;
    }
  }
  if (!erased) return erasePage; // nothing proven-chrome ⇒ return the cleaned input unchanged
  return await sharp(eData, { raw: { width: W, height: H, channels: eCh } }).png().toBuffer();
};

/** STAGE 0 toggle — default ON; set OCR_DISPLAY_STAGE0=false to disable. */
/** STAGE 0 runs when EITHER aggressive background removal OR content-safe page-chrome removal is on,
 *  so the header/footer/border eraser still runs while the background passes stay off. Each inner pass
 *  is independently gated (background passes by backgroundRemovalEnabled, chrome by chromeRemovalEnabled,
 *  footer by footerTrimEnabled). Disable the whole page pass with OCR_DISPLAY_STAGE0=false. */
export const stage0Enabled = (): boolean =>
  (backgroundRemovalEnabled() || pageChromeRemovalEnabled()) && process.env.OCR_DISPLAY_STAGE0 !== 'false';

/**
 * STAGE 0 — page-level SAFE background clean (the crop DISPLAY SOURCE).
 *
 * Produces ONE watermark-suppressed page by running the SAME mask-gated, flat-field-
 * guarded whitening as `cleanCropForDisplay`, but ONCE over the WHOLE page (region =
 * full page). The crops are later sliced from this page, so figure / diagram / graph
 * crops inherit a clean background WITHOUT any per-crop cleaning — `protectFigure`
 * stays intact and is never disabled. Text crops are unaffected (the per-crop pass is
 * idempotent on already-clean pixels).
 *
 * PROOF = cross-page persistence. Only pixels the flat field proves persistent (a
 * watermark / banner / logo / persistent divider-or-separator line / light persistent
 * trail) AND inside the large-watermark mask are whitened. Every unique pixel is bright
 * in the flat field ⇒ kept verbatim (a graph stroke, chemistry bond, arrow, label, or
 * table rule unique to this page is content, never background). No flat field (<3 pages
 * ⇒ no consensus ⇒ no proof) ⇒ the RAW page is returned unchanged.
 *
 * DISPLAY-ONLY: the returned image is used ONLY as the crop `displaySource`. OCR ran on
 * the separately-cleaned page; word boxes, segmentation, numbering, boundaries and every
 * draft field are derived upstream and are untouched ⇒ N=N / counts / boundaries cannot
 * change. Any error ⇒ the raw page (crops never break). Disable with OCR_DISPLAY_STAGE0=false.
 */
export const cleanPageForDisplay = async (
  page: Buffer,
  flat?: FlatField | null,
  mask?: WatermarkMask | null,
  /** This page's OCR word boxes (page-image coords). Used ONLY by the deterministic chrome
   *  pass for the reading-order + word-adjacency gate. Absent ⇒ chrome pass is a no-op. */
  words?: ChromeWord[] | null,
): Promise<Buffer> => {
  if (!stage0Enabled()) return page;
  try {
    let out = page;
    // (1) Cross-page consensus pass — removes PROVEN-persistent watermark / banner / logo / page-code
    // / separator pixels (requires ≥3 pages for a flat field). Skipped when there is no flat field.
    if (flat) {
      const meta = await sharp(out).metadata();
      const pageWidth = meta.width ?? 0;
      const pageHeight = meta.height ?? 0;
      if (pageWidth && pageHeight) {
        out = await cleanCropForDisplay(out, { flat, mask, region: { x0: 0, y0: 0, x1: pageWidth, y1: pageHeight }, pageWidth, pageHeight });
      }
    }
    // (1b) COLUMN-DIVIDER removal — the SAME pass in EVERY upload mode (single / partial / full).
    // With a flat field it locates the divider from cross-page consensus; without one it uses this
    // page's own geometry — one detector, so the same page gives the same result however uploaded.
    // Runs before the flatten so it reads the original ink. Display-only; no effect on OCR/drafts.
    {
      const meta = await sharp(out).metadata();
      const pw = meta.width ?? 0;
      const ph = meta.height ?? 0;
      if (pw && ph) out = await removeColumnDivider(out, { flat, pageWidth: pw, pageHeight: ph });
    }
    // (2) GENERIC illumination flatten — flat-field-FREE, runs on EVERY page (incl. 1–2 page uploads
    // with no consensus). Removes grey paper texture / scanning shadows / gradients / faint tints that
    // the consensus pass cannot prove. Content-safe by construction (see flattenIllumination).
    out = await flattenIllumination(out);
    // (3) DETERMINISTIC CHROME REMOVAL — connected-component erase of ISOLATED page chrome (codes /
    // logos / banners / borders / margin noise) under the strict 3-condition gate (persistent ∧
    // outside reading order ∧ not touching any word box). Requires BOTH the flat field (persistence
    // proof) and the page word boxes (reading-order + adjacency); a no-op without either.
    if (chromeRemovalEnabled() && flat && words && words.length) {
      const meta = await sharp(out).metadata();
      const pw = meta.width ?? 0;
      const ph = meta.height ?? 0;
      // Detect on the ORIGINAL `page` (chrome solid), erase on the cleaned `out` (no ghosts).
      if (pw && ph) out = await removeChromeComponents(page, out, flat, words, pw, ph);
    }
    // (4) PAGE-LEVEL FOOTER WHITEN — erase the bottom institute footer (phone / website / address) on
    // the PAGE, before any crop / cross-page stitch, so it can never land mid-crop or corrupt question
    // merging. Word-text proven, content-safe (cut below the last content line). No-op without words.
    if (words && words.length) {
      out = await (await import('./crop-display-trim')).whitenFooterBand(out, words);
    }
    return out;
  } catch {
    return page; // best-effort: never break the page (crops fall back to the raw page)
  }
};
