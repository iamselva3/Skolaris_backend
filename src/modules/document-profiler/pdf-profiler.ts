/*
 * DOCUMENT PROFILER — Phase 1 (pdfjs-dist ONLY, READ-ONLY).
 *
 * Pure functions. No NestJS, no transport, no storage, NO file mutation. The
 * profiler's single job is to look at a PDF's own structure and answer one
 * question the rest of the (future) enhancement flow gates on:
 *
 *     Is this a DIGITAL pdf (separable objects we could later clean safely)
 *     or a SCANNED pdf (one flattened raster per page — KEEP THE PIXELS)?
 *
 * It NEVER renders, never thresholds, never touches pixels. Everything is read
 * from the PDF's declared structure via pdfjs-dist:
 *   • native text layer        (getTextContent)
 *   • drawing operators + CTM   (getOperatorList) → image coverage, vector ink
 *   • annotations / OCG layers  (getAnnotations / getOptionalContentConfig)
 *
 * SAFETY BIAS (the Golden Rule, encoded): only POSITIVE evidence of native
 * digital composition yields 'DIGITAL'. Anything mixed, empty, image-dominated,
 * or unparseable → 'SCANNED' → the caller bypasses enhancement entirely. A
 * wrong guess can only ever cost a false BYPASS (safe), never a forced
 * enhancement of a scan.
 *
 * On the constants below: these are UNIVERSAL STRUCTURAL DEFINITIONS (what
 * "full-bleed image" or "majority of pages" MEAN), identical for every
 * document. They are NOT per-document tuning, NOT coordinates, and are NOT
 * env-exposed — there is nothing here for an operator to tune per PDF.
 */

// ── pdfjs-dist is ESM-only; load it via Function-indirection dynamic import so
// TS's commonjs target does not downlevel it to require() (same pattern as
// src/shared/ocr-engine/routing.ts). Any failure is caught by the caller and
// degrades to SCANNED/BYPASS.
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<unknown>;

type Matrix = [number, number, number, number, number, number];

interface PdfTextItem {
  str?: string;
}
interface PdfOpList {
  fnArray: number[];
  argsArray: unknown[][];
}
interface PdfAnnotation {
  subtype?: string;
}
interface PdfPageLike {
  view: number[];
  getTextContent: () => Promise<{ items: PdfTextItem[] }>;
  getOperatorList: () => Promise<PdfOpList>;
  getAnnotations: () => Promise<PdfAnnotation[]>;
}
interface PdfOcConfig {
  getGroups?: () => Record<string, unknown> | Map<string, unknown> | null;
}
interface PdfDocLike {
  numPages: number;
  getPage: (n: number) => Promise<PdfPageLike>;
  getOptionalContentConfig?: () => Promise<PdfOcConfig>;
  destroy?: () => Promise<void>;
}
interface PdfjsLike {
  getDocument: (src: Record<string, unknown>) => { promise: Promise<PdfDocLike> };
  OPS: Record<string, number>;
}

let pdfjs: PdfjsLike | null = null;
const loadPdfjs = async (): Promise<PdfjsLike> => {
  if (!pdfjs) {
    pdfjs = (await esmImport('pdfjs-dist/legacy/build/pdf.mjs')) as PdfjsLike;
  }
  return pdfjs;
};

/* ── Universal structural definitions (NOT tuning, NOT coordinates, NOT env) ── */
/** Cap on pages inspected — a representative spread is enough to classify. */
const MAX_SAMPLE_PAGES = 6;
/** An image whose drawn area covers ≥ this share of the page IS the page (full-bleed scan). */
const FULL_PAGE_COVERAGE = 0.8;
/** More than this many native paint ops ⇒ genuine vector drawing ⇒ digital, not a scan. */
const VECTOR_FLOOR = 3;
/** Positive digital evidence requires native composition on ≥ this share of sampled pages. */
const NATIVE_MAJORITY = 0.6;
/** …and full-bleed-image dominance on no more than this share. */
const IMAGE_MINORITY = 0.4;

export type DocVerdict = 'DIGITAL' | 'SCANNED';
export type PageVerdict = 'NATIVE' | 'IMAGE_DOMINATED' | 'EMPTY';

export interface PageProfile {
  page: number;
  textChars: number;
  vectorPaintOps: number;
  imageOps: number;
  /** 0..1 — largest single drawn image area / page area. */
  imageCoverage: number;
  verdict: PageVerdict;
}

export interface PdfProfile {
  pageCount: number;
  sampledPages: number;
  pages: PageProfile[];
  nativePageRatio: number;
  imageDominatedRatio: number;
  avgTextChars: number;
  /** Structural repeated-element signals (informational; consumed by later phases). */
  annotationSubtypes: Record<string, number>;
  /** XObject resource names drawn on more than one sampled page (e.g. a repeated watermark/logo). */
  repeatedXObjects: number;
  ocgLayers: number;
  /** 0..1 structural-only watermark likelihood (annotation / OCG / repeated object). */
  watermarkConfidence: number;
  verdict: DocVerdict;
  confidence: number;
  reason: string;
}

const mul = (m: Matrix, t: Matrix): Matrix => [
  m[0] * t[0] + m[2] * t[1],
  m[1] * t[0] + m[3] * t[1],
  m[0] * t[2] + m[2] * t[3],
  m[1] * t[2] + m[3] * t[3],
  m[0] * t[4] + m[2] * t[5] + m[4],
  m[1] * t[4] + m[3] * t[5] + m[5],
];

/** Spread up to MAX_SAMPLE_PAGES indices across [1..pageCount] (always includes first + last). */
const samplePages = (pageCount: number): number[] => {
  if (pageCount <= MAX_SAMPLE_PAGES) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const out = new Set<number>();
  for (let i = 0; i < MAX_SAMPLE_PAGES; i += 1) {
    const idx = 1 + Math.round((i * (pageCount - 1)) / (MAX_SAMPLE_PAGES - 1));
    out.add(idx);
  }
  return [...out].sort((a, b) => a - b);
};

interface PageWalk {
  vectorPaintOps: number;
  imageOps: number;
  imageCoverage: number;
  xobjectNames: string[];
}

/** Walk a page's operator list tracking the CTM to measure image coverage + native ink. */
const walkPage = (ops: PdfOpList, O: Record<string, number>, pageArea: number): PageWalk => {
  // Resolve the op codes we care about once (missing ones become -1 ⇒ never match).
  const code = (name: string): number => (typeof O[name] === 'number' ? O[name] : -1);
  const SAVE = code('save');
  const RESTORE = code('restore');
  const TRANSFORM = code('transform');
  const imageOpsSet = new Set(
    [
      'paintImageXObject',
      'paintImageXObjectRepeat',
      'paintJpegXObject',
      'paintInlineImageXObject',
      'paintImageMaskXObject',
    ].map(code),
  );
  const paintOpsSet = new Set(
    [
      // Native vector ink. `constructPath` is pdfjs's bundled path-construction op and
      // is a strong digital-composition signal — a scanned full-bleed-image page emits
      // none, so counting it improves digital detection without affecting scan detection.
      'constructPath',
      'fill',
      'eoFill',
      'stroke',
      'fillStroke',
      'eoFillStroke',
      'closeFillStroke',
      'closeEOFillStroke',
      'closeStroke',
    ].map(code),
  );
  const PAINT_FORM = code('paintFormXObject');
  const PAINT_IMG = code('paintImageXObject');
  const PAINT_JPEG = code('paintJpegXObject');

  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  let vectorPaintOps = 0;
  let imageOps = 0;
  let imageCoverage = 0;
  const xobjectNames: string[] = [];

  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] ?? [];
    if (fn === SAVE) {
      stack.push(ctm);
    } else if (fn === RESTORE) {
      ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    } else if (fn === TRANSFORM) {
      const a = args as unknown as number[];
      if (a.length >= 6) ctm = mul(ctm, [a[0], a[1], a[2], a[3], a[4], a[5]]);
    } else if (imageOpsSet.has(fn)) {
      imageOps += 1;
      // An image XObject is painted into the unit square transformed by the CTM.
      const w = Math.hypot(ctm[0], ctm[1]);
      const h = Math.hypot(ctm[2], ctm[3]);
      const cov = pageArea > 0 ? (w * h) / pageArea : 0;
      if (cov > imageCoverage) imageCoverage = cov;
      if ((fn === PAINT_IMG || fn === PAINT_JPEG) && typeof args[0] === 'string') {
        xobjectNames.push(args[0]);
      }
    } else if (paintOpsSet.has(fn)) {
      vectorPaintOps += 1;
    } else if (fn === PAINT_FORM && typeof args[0] === 'string') {
      xobjectNames.push(args[0]);
    }
  }

  return { vectorPaintOps, imageOps, imageCoverage: Math.min(1, imageCoverage), xobjectNames };
};

const classifyPage = (textChars: number, w: PageWalk): PageVerdict => {
  // A single full-bleed image with negligible native vector ink IS a scanned page —
  // even if a searchable scan added an INVISIBLE OCR text layer (textChars > 0).
  if (w.imageCoverage >= FULL_PAGE_COVERAGE && w.vectorPaintOps <= VECTOR_FLOOR) {
    return 'IMAGE_DOMINATED';
  }
  if (textChars > 0 || w.vectorPaintOps > 0 || w.imageOps > 0) return 'NATIVE';
  return 'EMPTY';
};

/**
 * Profile a PDF from its bytes. Pure + read-only. Throws only on a hard pdfjs
 * load failure (the caller catches and degrades to SCANNED/BYPASS).
 */
export const profilePdf = async (bytes: Buffer): Promise<PdfProfile> => {
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
  }).promise;

  try {
    const pageCount = doc.numPages;
    const indices = samplePages(pageCount);
    const pages: PageProfile[] = [];
    const annotationSubtypes: Record<string, number> = {};
    const xobjectPageCount = new Map<string, number>();
    let totalText = 0;

    for (const n of indices) {
      const page = await doc.getPage(n);
      const view = page.view ?? [0, 0, 0, 0];
      const pageArea = Math.max(0, (view[2] - view[0]) * (view[3] - view[1]));

      let textChars = 0;
      try {
        const tc = await page.getTextContent();
        for (const it of tc.items) textChars += (it.str ?? '').length;
      } catch {
        /* no text layer / parse issue ⇒ 0 chars (treated as non-native evidence) */
      }

      let walk: PageWalk = { vectorPaintOps: 0, imageOps: 0, imageCoverage: 0, xobjectNames: [] };
      try {
        const ops = await page.getOperatorList();
        walk = walkPage(ops, lib.OPS, pageArea);
      } catch {
        /* operator list unavailable ⇒ no native-ink evidence */
      }

      try {
        const annots = await page.getAnnotations();
        for (const a of annots) {
          const sub = a.subtype ?? 'Unknown';
          annotationSubtypes[sub] = (annotationSubtypes[sub] ?? 0) + 1;
        }
      } catch {
        /* annotations optional */
      }

      for (const name of new Set(walk.xobjectNames)) {
        xobjectPageCount.set(name, (xobjectPageCount.get(name) ?? 0) + 1);
      }

      totalText += textChars;
      pages.push({
        page: n,
        textChars,
        vectorPaintOps: walk.vectorPaintOps,
        imageOps: walk.imageOps,
        imageCoverage: Math.round(walk.imageCoverage * 100) / 100,
        verdict: classifyPage(textChars, walk),
      });
    }

    let ocgLayers = 0;
    try {
      if (doc.getOptionalContentConfig) {
        const occ = await doc.getOptionalContentConfig();
        const groups = occ?.getGroups?.();
        if (groups) ocgLayers = groups instanceof Map ? groups.size : Object.keys(groups).length;
      }
    } catch {
      /* OCG optional */
    }

    const sampled = pages.length;
    const nativeCount = pages.filter((p) => p.verdict === 'NATIVE').length;
    const imageDominated = pages.filter((p) => p.verdict === 'IMAGE_DOMINATED').length;
    const nativePageRatio = sampled > 0 ? nativeCount / sampled : 0;
    const imageDominatedRatio = sampled > 0 ? imageDominated / sampled : 0;
    const repeatedXObjects = [...xobjectPageCount.values()].filter((c) => c > 1).length;

    let watermarkConfidence = 0;
    const wmAnnots = (annotationSubtypes['Watermark'] ?? 0) + (annotationSubtypes['Stamp'] ?? 0);
    if (wmAnnots > 0) watermarkConfidence += 0.5;
    if (ocgLayers > 0) watermarkConfidence += 0.25;
    if (repeatedXObjects > 0) watermarkConfidence += 0.25;
    watermarkConfidence = Math.min(1, watermarkConfidence);

    // POSITIVE digital evidence required; everything else is SCANNED (safe default).
    let verdict: DocVerdict;
    let confidence: number;
    let reason: string;
    if (sampled === 0) {
      verdict = 'SCANNED';
      confidence = 0.5;
      reason = 'no pages could be profiled';
    } else if (nativePageRatio >= NATIVE_MAJORITY && imageDominatedRatio <= IMAGE_MINORITY) {
      verdict = 'DIGITAL';
      confidence = Math.round(nativePageRatio * 100) / 100;
      reason = 'native text/vector composition on the majority of sampled pages';
    } else {
      verdict = 'SCANNED';
      confidence = Math.round(Math.max(imageDominatedRatio, 1 - nativePageRatio) * 100) / 100;
      reason =
        imageDominated > 0
          ? 'one or more sampled pages are a full-bleed raster image'
          : 'insufficient positive evidence of native digital composition';
    }

    return {
      pageCount,
      sampledPages: sampled,
      pages,
      nativePageRatio: Math.round(nativePageRatio * 100) / 100,
      imageDominatedRatio: Math.round(imageDominatedRatio * 100) / 100,
      avgTextChars: sampled > 0 ? Math.round(totalText / sampled) : 0,
      annotationSubtypes,
      repeatedXObjects,
      ocgLayers,
      watermarkConfidence,
      verdict,
      confidence,
      reason,
    };
  } finally {
    if (doc.destroy) await doc.destroy().catch(() => undefined);
  }
};
