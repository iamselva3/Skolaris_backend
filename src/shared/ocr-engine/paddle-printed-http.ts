/*
 * Slice 2.2 — printed-paper OCR via the existing Python service (PaddleOCR).
 *
 * Sibling of handwriting-http.ts. Calls POST /ocr/extract-structured on the
 * service URL, returns the same per-page shape that Node's tesseract ocrPdf()
 * returns so the downstream column-reorder + page classification + parseDrafts
 * pipeline runs unchanged. Smart parsing stays in Node; heavy OCR is delegated.
 *
 * Hardened: AbortController timeout + tiny circuit breaker (shared shape with
 * handwriting-http but a separate breaker state so a slow handwriting service
 * doesn't poison the printed path). ANY failure returns null → the caller
 * degrades to the local tesseract path, NEVER blocks a job.
 */
import { randomUUID } from 'crypto';
import type { OcrEngineFigure, OcrPageResult } from './ocr-engine';
import type { OcrWordBox, ReorderLayout } from './column-reorder';
import { reorderByColumns } from './column-reorder';

export interface PaddlePrintedDeps {
  serviceUrl: string | null;
  storageKey: string;
  mime: string;
  timeoutMs: number;
  /** Server-side direct upload for figure crops. If absent, figures are skipped. */
  putObject?: (key: string, body: Buffer, contentType: string) => Promise<void>;
  /** Storage-key prefix for uploaded figure crops, e.g. `tenants/{T}/ocr-figures`. */
  figureKeyPrefix?: string;
}

/** Per-page figure (post-upload) before draft association. Internal to engine. */
export interface PageFigureRef extends OcrEngineFigure {
  /** Pixel center-Y on the page (for proportional-Y draft association). */
  centerY: number;
  /** Page height in pixels (so association can normalize). */
  pageHeight: number;
}

export interface PaddlePrintedResult {
  pages: OcrPageResult[];
  combinedText: string;
  confidence: number;
  pageCount: number;
  wordConfidences: number[];
  providerUsed: string;
  /** Figures grouped by pageNumber (post-upload). Empty if no putObject was provided. */
  figuresByPage: Map<number, PageFigureRef[]>;
  /** Phase B — typed regions (flat, global readingOrder). Empty when the
   *  Python `OCR_PP_STRUCTURE_ENABLED` flag is off. Image-bearing regions
   *  (FIGURE/TABLE) have already been uploaded to R2 — `storageKey` is set
   *  and `imageB64` is dropped from this shape. */
  regions: OcrRegion[];
}

const THRESHOLD = Number(process.env.PRINTED_OCR_BREAKER_THRESHOLD) || 3;
const COOLDOWN_MS = Number(process.env.PRINTED_OCR_BREAKER_COOLDOWN_MS) || 30_000;
const breaker = { failures: 0, openUntil: 0 };

export const getPrintedBreakerState = (): {
  failures: number;
  open: boolean;
  openUntil: number;
} => ({
  failures: breaker.failures,
  open: breaker.openUntil > Date.now(),
  openUntil: breaker.openUntil,
});

export const resetPrintedBreaker = (): void => {
  breaker.failures = 0;
  breaker.openUntil = 0;
};

const recordFailure = (): void => {
  breaker.failures += 1;
  if (breaker.failures >= THRESHOLD) breaker.openUntil = Date.now() + COOLDOWN_MS;
};

interface StructuredResponseWord {
  text?: string;
  x0?: number;
  y0?: number;
  x1?: number;
  y1?: number;
  conf?: number;
}
interface StructuredResponseFigure {
  kind?: string;
  x0?: number;
  y0?: number;
  x1?: number;
  y1?: number;
  imageB64?: string;
  caption?: string;
}
interface StructuredResponsePage {
  pageNumber?: number;
  text?: string;
  confidence?: number;
  words?: StructuredResponseWord[];
  figures?: StructuredResponseFigure[];
  pageWidth?: number;
  pageHeight?: number;
}

/**
 * Phase B — typed region contract. The union includes the 6 initially emitted
 * types AND all reserved-for-Phase-C types up front so adding them later is
 * additive (no breaking wire change). The Python service today emits only the
 * 6 initial types; Node consumers may safely discriminate on the wider union.
 */
export type OcrRegionType =
  // Initially supported by Python (PP-Structure):
  | 'TEXT'
  | 'TITLE'
  | 'TABLE'
  | 'FIGURE'
  | 'HEADER'
  | 'FOOTER'
  // Phase C reserved — declared now so they don't become a breaking change later:
  | 'QUESTION'
  | 'OPTION'
  | 'FORMULA'
  | 'GRAPH'
  | 'CHEM_STRUCTURE'
  | 'DIAGRAM'
  | 'ANSWER'
  | 'SOLUTION'
  | 'WATERMARK';

interface StructuredResponseRegion {
  type?: string;
  pageNumber?: number;
  bbox?: [number, number, number, number];
  confidence?: number;
  readingOrder?: number;
  content?: string | null;
  tableHtml?: string | null;
  imageB64?: string | null;
  metadata?: Record<string, unknown>;
}

interface StructuredResponse {
  providerUsed?: string;
  overallConfidence?: number;
  pages?: StructuredResponsePage[];
  /** Phase B — flat list of typed layout regions, global readingOrder. */
  regions?: StructuredResponseRegion[];
}

/**
 * Phase B — public region type carried into the engine. Figure/Table regions
 * with imageB64 are uploaded to R2 server-side (same path as page.figures);
 * `imageB64` is dropped from this shape and replaced by `storageKey`.
 */
export interface OcrRegion {
  type: OcrRegionType;
  pageNumber: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
  readingOrder: number;
  content: string | null;
  tableHtml: string | null;
  /** R2 storage key when the region is FIGURE/TABLE and was uploaded. */
  storageKey: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Returns null on ANY failure (no URL, circuit open, timeout, non-2xx, malformed
 * body). The caller (extractDrafts) then falls back to the Node tesseract path.
 */
export const ocrPdfViaPaddle = async (
  deps: PaddlePrintedDeps,
): Promise<PaddlePrintedResult | null> => {
  if (!deps.serviceUrl) return null;
  if (breaker.openUntil > Date.now()) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const res = await fetch(`${deps.serviceUrl.replace(/\/+$/, '')}/ocr/extract-structured`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ storageKey: deps.storageKey, mime: deps.mime }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`paddle printed HTTP ${res.status}`);
    const data = (await res.json()) as StructuredResponse;
    if (!Array.isArray(data.pages) || data.pages.length === 0) {
      throw new Error('paddle printed returned no pages');
    }

    breaker.failures = 0;
    breaker.openUntil = 0;

    // Upload figure crops (if the caller provided a putObject hook + prefix).
    // The Python service returns base64 PNGs; we decode + PUT directly to R2,
    // never round-tripping the bytes back through the client.
    const figuresByPage = new Map<number, PageFigureRef[]>();
    const canUploadFigures = !!deps.putObject && !!deps.figureKeyPrefix;
    let uploadedFigureCount = 0;
    if (canUploadFigures) {
      const prefix = deps.figureKeyPrefix!.replace(/\/+$/, '');
      for (const p of data.pages) {
        const pageNumber = typeof p.pageNumber === 'number' ? p.pageNumber : 0;
        const pageHeight = typeof p.pageHeight === 'number' ? p.pageHeight : 0;
        const figs = p.figures ?? [];
        if (figs.length === 0) continue;
        const pageFigures: PageFigureRef[] = [];
        for (let fIdx = 0; fIdx < figs.length; fIdx += 1) {
          const f = figs[fIdx];
          if (
            !f.imageB64 ||
            typeof f.x0 !== 'number' ||
            typeof f.y0 !== 'number' ||
            typeof f.x1 !== 'number' ||
            typeof f.y1 !== 'number'
          )
            continue;
          let bytes: Buffer;
          try {
            bytes = Buffer.from(f.imageB64, 'base64');
          } catch {
            continue;
          }
          const storageKey = `${prefix}/${randomUUID()}.png`;
          try {
            await deps.putObject!(storageKey, bytes, 'image/png');
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
              `[paddle-printed] figure upload failed page=${pageNumber} idx=${fIdx}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            continue;
          }
          uploadedFigureCount += 1;
          pageFigures.push({
            storageKey,
            kind:
              f.kind === 'table' || f.kind === 'graph' || f.kind === 'formula'
                ? (f.kind as PageFigureRef['kind'])
                : 'figure',
            boundingBox: { x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1, page: pageNumber },
            caption: f.caption,
            centerY: (f.y0 + f.y1) / 2,
            pageHeight,
          });
        }
        if (pageFigures.length > 0) figuresByPage.set(pageNumber, pageFigures);
      }
      if (uploadedFigureCount > 0) {
        // eslint-disable-next-line no-console
        console.log(`[paddle-printed] uploaded ${uploadedFigureCount} figure crop(s)`);
      }
    }

    // Phase B — parse top-level regions[]. FIGURE/TABLE crops are uploaded
    // to R2 the same way page.figures are; `imageB64` is replaced by the
    // resulting `storageKey`. Non-image regions (TEXT/TITLE/HEADER/FOOTER)
    // pass through with their content unchanged. Empty when Python flag off.
    const regions: OcrRegion[] = [];
    const supportedTypes = new Set<OcrRegionType>([
      'TEXT',
      'TITLE',
      'TABLE',
      'FIGURE',
      'HEADER',
      'FOOTER',
      'QUESTION',
      'OPTION',
      'FORMULA',
      'GRAPH',
      'CHEM_STRUCTURE',
      'DIAGRAM',
      'ANSWER',
      'SOLUTION',
      'WATERMARK',
    ]);
    const responseRegions = data.regions ?? [];
    if (responseRegions.length > 0) {
      const regionPrefix = canUploadFigures ? deps.figureKeyPrefix!.replace(/\/+$/, '') : null;
      let uploadedRegionCount = 0;
      for (const r of responseRegions) {
        const rawType = (r.type ?? 'TEXT').toUpperCase();
        if (!supportedTypes.has(rawType as OcrRegionType)) continue;
        const type = rawType as OcrRegionType;
        const bbox = r.bbox;
        if (!bbox || bbox.length !== 4) continue;
        const pageNumber = typeof r.pageNumber === 'number' ? r.pageNumber : 0;
        const readingOrder = typeof r.readingOrder === 'number' ? r.readingOrder : regions.length;
        const confidence = typeof r.confidence === 'number' ? r.confidence : 0;

        let storageKey: string | null = null;
        if (
          regionPrefix &&
          (type === 'FIGURE' || type === 'TABLE') &&
          r.imageB64 &&
          typeof r.imageB64 === 'string'
        ) {
          let bytes: Buffer;
          try {
            bytes = Buffer.from(r.imageB64, 'base64');
          } catch {
            bytes = Buffer.alloc(0);
          }
          if (bytes.length > 0) {
            const key = `${regionPrefix}/region-${randomUUID()}.png`;
            try {
              await deps.putObject!(key, bytes, 'image/png');
              storageKey = key;
              uploadedRegionCount += 1;
            } catch (err) {
              // eslint-disable-next-line no-console
              console.warn(
                `[paddle-printed] region image upload failed page=${pageNumber} type=${type}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          }
        }

        regions.push({
          type,
          pageNumber,
          bbox: { x0: bbox[0], y0: bbox[1], x1: bbox[2], y1: bbox[3] },
          confidence,
          readingOrder,
          content: typeof r.content === 'string' ? r.content : null,
          tableHtml: typeof r.tableHtml === 'string' ? r.tableHtml : null,
          storageKey,
          metadata: r.metadata && typeof r.metadata === 'object' ? r.metadata : {},
        });
      }
      if (uploadedRegionCount > 0) {
        // eslint-disable-next-line no-console
        console.log(`[paddle-printed] uploaded ${uploadedRegionCount} region crop(s)`);
      }
    }

    const pages: OcrPageResult[] = data.pages.map((p, i) => {
      const pageNumber = typeof p.pageNumber === 'number' ? p.pageNumber : i + 1;
      const confidence = typeof p.confidence === 'number' ? p.confidence : 0;
      const wordBoxes: OcrWordBox[] = (p.words ?? [])
        .filter(
          (w): w is Required<StructuredResponseWord> =>
            typeof w.text === 'string' &&
            typeof w.x0 === 'number' &&
            typeof w.y0 === 'number' &&
            typeof w.x1 === 'number' &&
            typeof w.y1 === 'number',
        )
        .map((w) => ({ text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }));
      const wordConfidences: number[] = (p.words ?? [])
        .map((w) => (typeof w.conf === 'number' ? Math.round(w.conf * 100) : null))
        .filter((c): c is number => c !== null);

      // Run the SAME column reorder as the tesseract path. Single chokepoint
      // means the layout fix improves equally regardless of OCR backend.
      let text = (p.text ?? '').trim();
      let layout: ReorderLayout = 'UNKNOWN';
      let splitX: number | null = null;
      let layoutConfidence = 0;
      let columns: string[] = [text];
      if (wordBoxes.length > 0) {
        const rr = reorderByColumns(wordBoxes);
        text = rr.text;
        layout = rr.layout;
        splitX = rr.splitX;
        layoutConfidence = rr.confidence;
        columns = rr.columns;
      }
      return {
        pageNumber,
        text,
        confidence,
        wordConfidences,
        layout,
        splitX,
        layoutConfidence,
        columns,
      };
    });

    const combinedText = pages.map((p) => p.text).join('\n\n');
    const overall =
      typeof data.overallConfidence === 'number'
        ? data.overallConfidence
        : pages.length > 0
          ? pages.reduce((s, p) => s + p.confidence, 0) / pages.length
          : 0;
    const flatWordConfidences = pages.flatMap((p) => p.wordConfidences);

    return {
      pages,
      combinedText,
      confidence: overall,
      pageCount: pages.length,
      wordConfidences: flatWordConfidences,
      providerUsed: data.providerUsed ?? 'paddle-printed',
      figuresByPage,
      regions,
    };
  } catch {
    recordFailure();
    return null;
  } finally {
    clearTimeout(timer);
  }
};
