import { PDFDocument } from 'pdf-lib';
import { detectColumns, reflowPage, REFLOW_CONFIDENCE, shouldReflow } from './column-reflow';

/**
 * PDF-level orchestration for the column-reflow preprocess layer. Renders the uploaded
 * PDF to page images (the SAME pdf-to-img @ scale 2 the unchanged engine uses), reflows
 * only the confidently-detected true multi-column pages, and reassembles a new PDF.
 *
 * SAFETY — the "identical" guarantee: if NO page reflows (single-column / full-width /
 * low-confidence / divider-separated papers), we return changed:false and the caller
 * leaves the ORIGINAL object untouched, so RE NEET PST / Biology go through the unchanged
 * pipeline byte-for-byte. Only a paper with ≥1 genuinely reflowed page is rebuilt.
 *
 * Resolution parity: each rebuilt page's size in POINTS = imagePixels / RENDER_SCALE, so
 * when the engine re-renders the PDF at scale 2 it reproduces the original pixel
 * resolution — kept-as-is pages stay visually identical and OCR sees the same input.
 *
 * NEVER imports src/shared/ocr-engine/* — this is a standalone preprocess layer.
 */

const RENDER_SCALE = 2; // must match the engine's pdf-to-img scale (ocr-engine renders @2)

// pdf-to-img is ESM-only; load it via Function-indirection dynamic import so requiring
// this CJS module never eagerly bootstraps the ESM package (same trick the engine uses).
const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

export interface PageReflowSummary {
  page: number;
  detectedColumns: number;
  confidence: number;
  action: 'reflow' | 'no-op';
  reason: string;
}

export interface PdfReflowResult {
  changed: boolean;
  /** New PDF bytes — present only when changed:true. */
  pdf: Buffer | null;
  pageCount: number;
  reflowedPages: number;
  summary: PageReflowSummary[];
}

const renderPdf = async (bytes: Buffer): Promise<Buffer[]> => {
  const { pdf } = (await esmImport('pdf-to-img')) as {
    pdf: (input: Buffer, opts?: { scale?: number }) => Promise<AsyncIterable<Buffer>>;
  };
  const doc = await pdf(bytes, { scale: RENDER_SCALE });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);
  return pages;
};

/**
 * Detect + reflow a PDF in memory. Returns the new PDF only if at least one page was a
 * confident true multi-column page; otherwise changed:false (caller keeps the original).
 */
export const reflowPdf = async (bytes: Buffer): Promise<PdfReflowResult> => {
  const pages = await renderPdf(bytes);
  const summary: PageReflowSummary[] = [];
  const outImages: Buffer[] = [];
  let reflowedPages = 0;

  for (let i = 0; i < pages.length; i += 1) {
    const layout = await detectColumns(pages[i]);
    if (shouldReflow(layout)) {
      const { reflowed } = await reflowPage(pages[i]);
      if (reflowed) {
        reflowedPages += 1;
        outImages.push(reflowed);
        summary.push({ page: i + 1, detectedColumns: layout.columns, confidence: layout.confidence, action: 'reflow', reason: layout.reason });
        continue;
      }
    }
    // single-column / full-width / low-confidence / reflow declined → keep original page.
    outImages.push(pages[i]);
    summary.push({
      page: i + 1,
      detectedColumns: layout.columns,
      confidence: layout.confidence,
      action: 'no-op',
      reason: layout.confidence < REFLOW_CONFIDENCE ? `confidence ${layout.confidence} < ${REFLOW_CONFIDENCE}` : layout.reason,
    });
  }

  if (reflowedPages === 0) {
    return { changed: false, pdf: null, pageCount: pages.length, reflowedPages: 0, summary };
  }

  // Reassemble: embed each page image (reflowed or kept) at pixels/scale points.
  const out = await PDFDocument.create();
  for (const img of outImages) {
    const png = await out.embedPng(img); // pdf-to-img + sharp both emit PNG
    const wPt = png.width / RENDER_SCALE;
    const hPt = png.height / RENDER_SCALE;
    const page = out.addPage([wPt, hPt]);
    page.drawImage(png, { x: 0, y: 0, width: wPt, height: hPt });
  }
  const pdf = Buffer.from(await out.save());
  return { changed: true, pdf, pageCount: pages.length, reflowedPages, summary };
};
