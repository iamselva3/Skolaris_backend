import sharp from 'sharp';

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const byte = (x: number): number => (x <= 0 ? 0 : x >= 255 ? 255 : x | 0);

/** Watermark-removal preprocessing enabled? Default ON; set
 *  OCR_WATERMARK_REMOVAL=false to disable (e.g. a paper with none). */
export const watermarkRemovalEnabled = (): boolean => process.env.OCR_WATERMARK_REMOVAL !== 'false';

// Detection is done on small, sampled pages — a watermark is large and diffuse,
// so full-resolution / every-page scanning is wasteful (it was the timeout
// cause). Both are env-tunable.
const detectWidth = (): number =>
  clamp(Number(process.env.OCR_WATERMARK_DETECT_WIDTH ?? 700), 200, 2000);
// DEFAULT 3 (was 16). The flat field is the per-pixel BRIGHTEST across sampled
// pages; MORE samples find white at more locations → a brighter flat → a MORE
// aggressive division in cleanPageImage that OVER-erases faint content. On the full
// RE NEET PST paper the 16-sample flat erased Q111's number ("111." → "Ht"),
// merging Q110/111 — yet the 3-page partial PDF (which can only sample 3) split them
// correctly. Sampling 3 makes the full paper behave like the partial: VERIFIED to
// recover Q110/111 with ZERO regression (full paper + all reference PDFs unchanged
// otherwise), and it is FASTER (fewer pages scanned, so no timeout risk). Small PDFs
// were already ≤3-page-sampled, so they are unaffected. Env-tunable to revert.
const samplePageCap = (): number =>
  clamp(Number(process.env.OCR_WATERMARK_SAMPLE_PAGES ?? 3), 3, 80);
// Minimum pages for cross-page consensus. DEFAULT 3 — this is intentionally NOT
// lowered: the same flat field feeds BOTH the display cleanup AND cleanPageImage
// (the image OCR runs on). Lowering to 2 switches 2-page OCR from luminanceClean to
// flatFieldClean, which REGRESSED question splitting on the real RE NEET PST PDFs
// (167→67, 168 dropped). The env knob exists only as an explicit, eyes-open opt-in;
// do not change the default without re-running scripts/diag-ocr.ts on a 2-page PDF.
const minPages = (): number => clamp(Number(process.env.OCR_WATERMARK_MIN_PAGES ?? 3), 2, 80);

// Lossless but FAST PNG encode for the transient cleaned page (it's only handed
// to OCR + the cropper, never stored — crops are re-encoded separately).
const fastPng = { compressionLevel: 1 } as const;

/**
 * Cross-page watermark estimate — the per-pixel BRIGHTEST value across pages.
 * Question content varies page to page (→ white in the max); a watermark sits at
 * the SAME spot on every page (→ persists at its darker level). White everywhere
 * except the watermark = a "flat field" to divide out. Built at LOW resolution
 * from a SAMPLE of pages for speed; upscaled when applied.
 */
export interface FlatField {
  width: number;
  height: number;
  data: Uint8Array; // greyscale, length = width*height
}

/** Evenly spread `max` pages across the document (all of them when there are fewer). */
const samplePages = (pages: Buffer[], max: number): Buffer[] => {
  if (pages.length <= max) return pages;
  const out: Buffer[] = [];
  const step = pages.length / max;
  for (let i = 0; i < max; i += 1)
    out.push(pages[Math.min(pages.length - 1, Math.floor(i * step))]);
  return out;
};

export const buildFlatField = async (pages: Buffer[]): Promise<FlatField | null> => {
  if (!watermarkRemovalEnabled() || pages.length < minPages()) return null;
  const meta = await sharp(pages[0]).metadata();
  const w0 = meta.width ?? 0;
  const h0 = meta.height ?? 0;
  if (!w0 || !h0) return null;

  // Low-res detection grid (preserve aspect).
  const dw = Math.min(detectWidth(), w0);
  const dh = Math.max(1, Math.round((dw * h0) / w0));
  const sample = samplePages(pages, samplePageCap());

  const max = new Uint8Array(dw * dh); // starts at 0 → grows to the brightest
  try {
    for (const buf of sample) {
      const { data } = await sharp(buf)
        .grayscale()
        .toColourspace('b-w')
        .resize(dw, dh, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });
      const n = Math.min(max.length, data.length);
      for (let i = 0; i < n; i += 1) if (data[i] > max[i]) max[i] = data[i];
    }
  } catch {
    return null;
  }
  return { width: dw, height: dh, data: max };
};

/**
 * Page-level watermark MASK — the LARGE, persistent (cross-page) grey regions:
 * big institute logos, diagonal name banners, central stamps. Built from the flat
 * field by (1) taking persistent-grey pixels (grey in the flat ⇒ never white on
 * any page ⇒ a watermark candidate), (2) dilating so the separated letters/strokes
 * of one watermark MERGE into a blob, (3) labelling connected components and
 * KEEPING ONLY LARGE ones. Small persistent blobs (page codes like CC-315) and
 * thin/unique content strokes are never large ⇒ excluded from the mask.
 *
 * The mask is used ONLY as a GATE for the display crop: a pixel may be whitened
 * only if it ALSO lies inside this mask. So adding the mask can only make the
 * display pass keep MORE (never whiten more than before) — thin lines, small
 * labels, formulae and diagram detail that fall outside a large watermark blob
 * become structurally impossible to whiten. Same low resolution as the flat
 * field; resampled to a crop when applied. */
export interface WatermarkMask {
  width: number;
  height: number;
  // 255 = large persistent watermark (removal candidate), 0 = protect. MUST be
  // 0/255 (not 0/1): the display gate resamples this with bilinear interpolation
  // and tests `mreg[p] < 128`, so a 0/1 mask would read as "outside" everywhere.
  data: Uint8Array;
}

/** Flat luma in [GREY_FLOOR, BRIGHT_CEIL) ⇒ persistent grey ⇒ watermark candidate.
 *  Below the floor = persistent DARK (likely a repeated rule/border — leave it);
 *  at/above the ceiling = white on some page = content-capable (protect). */
const WM_MASK_GREY_FLOOR = Number(process.env.OCR_DISPLAY_WM_MASK_GREY_FLOOR ?? 110);
const WM_MASK_BRIGHT_CEIL = Number(process.env.OCR_DISPLAY_WM_MASK_BRIGHT_CEIL ?? 238);
/** Dilation (flat-grid px) that merges the strokes of one watermark into a blob. */
const WM_MASK_DILATE = Math.max(0, Math.round(Number(process.env.OCR_DISPLAY_WM_MASK_DILATE ?? 4)));
/** A component is "large" if its bbox spans this fraction of the page's longer
 *  side OR its area is this fraction of the page — either alone qualifies, so a
 *  long thin diagonal banner AND a blocky central stamp both pass. */
const WM_MASK_MIN_SPAN_FRAC = Number(process.env.OCR_DISPLAY_WM_MASK_MIN_SPAN ?? 0.18);
const WM_MASK_MIN_AREA_FRAC = Number(process.env.OCR_DISPLAY_WM_MASK_MIN_AREA ?? 0.015);

/** Binary dilation by Chebyshev radius `r` (separable H then V running-OR). */
const dilateFlatMask = (mask: Uint8Array, w: number, h: number, r: number): Uint8Array => {
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
  for (let x = 0; x < w; x += 1)
    for (let y = 0; y < h; y += 1) {
      let v = 0;
      for (let dy = -r; dy <= r && !v; dy += 1) {
        const yy = y + dy;
        if (yy >= 0 && yy < h && tmp[yy * w + x]) v = 1;
      }
      out[y * w + x] = v;
    }
  return out;
};

/** One connected component of the dilated candidate map, with the stats used to
 *  accept/reject it. Exposed for diagnostics (`analyzeWatermarkMask`). */
export interface WatermarkComponent {
  id: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number; // pixels in the (dilated) component
  candArea: number; // of those, how many were original grey candidates
  span: number; // max(bbox width, bbox height)
  flatMean: number; // mean flat luma over the component's candidate pixels
  flatMin: number;
  flatMax: number;
  accepted: boolean;
  reason: string; // why accepted / rejected
}

/** Full analysis behind `buildWatermarkMask` — the candidate map, the dilated
 *  map, every component with its stats and accept/reject reason, and the final
 *  large-only mask. `buildWatermarkMask` is just `{ ...mask }` from this. */
export interface WatermarkAnalysis {
  width: number;
  height: number;
  candidate: Uint8Array; // persistent-grey candidates (pre-dilation)
  merged: Uint8Array; // candidates after dilation (component input)
  mask: Uint8Array; // final large-only mask
  components: WatermarkComponent[];
  minSpan: number;
  minArea: number;
  greyFloor: number;
  brightCeil: number;
  dilate: number;
}

/**
 * Analyse the flat field into watermark components + the final mask. Pure CPU on
 * the small flat grid (no I/O). Returns null without a flat field (single image /
 * <3 pages) — without cross-page consensus nothing may be removed.
 */
export const analyzeWatermarkMask = (flat: FlatField | null): WatermarkAnalysis | null => {
  if (!flat) return null;
  const { width: w, height: h, data: f } = flat;
  const cand = new Uint8Array(w * h);
  for (let i = 0; i < f.length; i += 1)
    if (f[i] >= WM_MASK_GREY_FLOOR && f[i] < WM_MASK_BRIGHT_CEIL) cand[i] = 1;

  const merged = dilateFlatMask(cand, w, h, WM_MASK_DILATE);

  // Connected components (8-connectivity) via iterative flood fill.
  const labels = new Int32Array(w * h); // 0 = unvisited
  const area: number[] = [0];
  const candArea: number[] = [0];
  const sum: number[] = [0];
  const fmin: number[] = [0];
  const fmax: number[] = [0];
  const x0: number[] = [0];
  const y0: number[] = [0];
  const x1: number[] = [0];
  const y1: number[] = [0];
  const stack: number[] = [];
  let next = 0;
  for (let p = 0; p < merged.length; p += 1) {
    if (!merged[p] || labels[p]) continue;
    next += 1;
    labels[p] = next;
    let a = 0;
    let ca = 0;
    let s = 0;
    let mn = 255;
    let mx = 0;
    let bx0 = w;
    let by0 = h;
    let bx1 = 0;
    let by1 = 0;
    stack.length = 0;
    stack.push(p);
    while (stack.length) {
      const q = stack.pop() as number;
      const qx = q % w;
      const qy = (q / w) | 0;
      a += 1;
      if (cand[q]) {
        ca += 1;
        const v = f[q];
        s += v;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (qx < bx0) bx0 = qx;
      if (qx > bx1) bx1 = qx;
      if (qy < by0) by0 = qy;
      if (qy > by1) by1 = qy;
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          const nx = qx + dx;
          const ny = qy + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const nq = ny * w + nx;
          if (merged[nq] && !labels[nq]) {
            labels[nq] = next;
            stack.push(nq);
          }
        }
    }
    area[next] = a;
    candArea[next] = ca;
    sum[next] = s;
    fmin[next] = mn;
    fmax[next] = mx;
    x0[next] = bx0;
    y0[next] = by0;
    x1[next] = bx1;
    y1[next] = by1;
  }

  const minSpan = Math.round(Math.max(w, h) * WM_MASK_MIN_SPAN_FRAC);
  const minArea = Math.round(w * h * WM_MASK_MIN_AREA_FRAC);
  const keep = new Uint8Array(next + 1);
  const components: WatermarkComponent[] = [];
  for (let c = 1; c <= next; c += 1) {
    const span = Math.max(x1[c] - x0[c] + 1, y1[c] - y0[c] + 1);
    const bigSpan = span >= minSpan;
    const bigArea = area[c] >= minArea;
    const accepted = bigSpan || bigArea;
    keep[c] = accepted ? 1 : 0;
    components.push({
      id: c,
      x0: x0[c],
      y0: y0[c],
      x1: x1[c],
      y1: y1[c],
      area: area[c],
      candArea: candArea[c],
      span,
      flatMean: candArea[c] ? Math.round(sum[c] / candArea[c]) : 0,
      flatMin: candArea[c] ? fmin[c] : 0,
      flatMax: candArea[c] ? fmax[c] : 0,
      accepted,
      reason: accepted
        ? `accepted: ${bigSpan ? `span ${span}>=${minSpan}` : ''}${bigSpan && bigArea ? ' & ' : ''}${bigArea ? `area ${area[c]}>=${minArea}` : ''}`
        : `rejected: span ${span}<${minSpan} AND area ${area[c]}<${minArea}`,
    });
  }

  const mask = new Uint8Array(w * h);
  for (let p = 0; p < mask.length; p += 1) if (keep[labels[p]]) mask[p] = 1;
  return {
    width: w,
    height: h,
    candidate: cand,
    merged,
    mask,
    components,
    minSpan,
    minArea,
    greyFloor: WM_MASK_GREY_FLOOR,
    brightCeil: WM_MASK_BRIGHT_CEIL,
    dilate: WM_MASK_DILATE,
  };
};

/**
 * Build the page-level large-watermark mask from a flat field. Thin wrapper over
 * `analyzeWatermarkMask` (see it for the algorithm). Returns null when there is
 * no flat field — without cross-page consensus nothing may be removed.
 */
export const buildWatermarkMask = (flat: FlatField | null): WatermarkMask | null => {
  const a = analyzeWatermarkMask(flat);
  if (!a) return null;
  // Emit 0/255 (analysis mask is 0/1) so the display gate's `< 128` test — applied
  // after a bilinear resample — correctly reads inside vs outside the mask.
  return { width: a.width, height: a.height, data: Uint8Array.from(a.mask, (v) => (v ? 255 : 0)) };
};

/** Resize the (small) flat field up to a page's dimensions. */
// NOTE: deliberately NOT forcing single channel here (unlike flatForRegion in
// crop-display-clean.ts). This function feeds cleanPageImage → the image OCR runs
// on. "Correcting" the channel handling shifts the OCR-fed pixels enough to break
// question-marker detection (it merged Q20-23 and misread "20"→"80" on the real
// RE NEET PST PDFs). The OCR path is left EXACTLY as it was; only the DISPLAY path
// got the channel fix. Do not change without re-running scripts/diag-ocr.ts.
const flatAt = async (flat: FlatField, w: number, h: number): Promise<Uint8Array> => {
  if (flat.width === w && flat.height === h) return flat.data;
  const out = await sharp(Buffer.from(flat.data), {
    raw: { width: flat.width, height: flat.height, channels: 1 },
  })
    .resize(w, h, { fit: 'fill' })
    .raw()
    .toBuffer();
  return new Uint8Array(out.buffer, out.byteOffset, out.length);
};

/**
 * Flat-field correction: divide each page by the cross-page watermark estimate.
 * Watermark pixel ≈ flat → ratio 1 → white (removed, however dark). Content pixel
 * is darker than flat → ratio low → preserved. Removes DARK diagonal watermarks
 * the luminance threshold can't, while protecting question content (it isn't in
 * the flat field).
 */
const flatFieldClean = async (pageImage: Buffer, flat: FlatField): Promise<Buffer> => {
  const { data, info } = await sharp(pageImage)
    .flatten({ background: '#ffffff' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const f = await flatAt(flat, width, height);

  for (let i = 0, fi = 0; fi < width * height; fi += 1, i += channels) {
    const gain = 255 / Math.max(f[fi], 1);
    data[i] = byte(data[i] * gain);
    if (channels >= 3) {
      data[i + 1] = byte(data[i + 1] * gain);
      data[i + 2] = byte(data[i + 2] * gain);
    }
  }
  return sharp(data, { raw: { width, height, channels } }).png(fastPng).toBuffer();
};

/** Single-page luminance fallback — whiten pixels lighter than the threshold.
 *  Good for LIGHT watermarks when no cross-page field exists. */
const luminanceClean = async (pageImage: Buffer): Promise<Buffer> => {
  const threshold = clamp(Number(process.env.OCR_WATERMARK_THRESHOLD ?? 200), 120, 250);
  const { data, info } = await sharp(pageImage)
    .flatten({ background: '#ffffff' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  if (ch < 3) {
    for (let i = 0; i < data.length; i += 1) if (data[i] > threshold) data[i] = 255;
  } else {
    for (let i = 0; i + 2 < data.length; i += ch) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum > threshold) {
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
      }
    }
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: ch } })
    .png(fastPng)
    .toBuffer();
};

/**
 * Watermark-removal PREPROCESSING — runs BEFORE OCR + segmentation, feeding a
 * cleaner page into the EXISTING pipeline (engine + segmenter unchanged). With a
 * cross-page `flat` field (multi-page PDFs) it removes DARK and light repeated
 * watermarks via flat-field correction; otherwise it falls back to the
 * single-page luminance method. Returns the original buffer on any error.
 *
 * Tuning:
 *   OCR_WATERMARK_REMOVAL=false       → disable the stage
 *   OCR_WATERMARK_DETECT_WIDTH=700    → flat-field detection resolution
 *   OCR_WATERMARK_SAMPLE_PAGES=16     → max pages scanned to build the flat field
 *   OCR_WATERMARK_THRESHOLD=200       → luminance cutoff for the single-page fallback
 */
export const cleanPageImage = async (
  pageImage: Buffer,
  flat?: FlatField | null,
): Promise<Buffer> => {
  if (!watermarkRemovalEnabled()) return pageImage;
  try {
    return flat ? await flatFieldClean(pageImage, flat) : await luminanceClean(pageImage);
  } catch {
    return pageImage; // preprocessing must never break the pipeline
  }
};
