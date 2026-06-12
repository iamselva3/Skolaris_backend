/**
 * Dedicated, ISOLATED answer-key OCR.
 *
 * Answer-key OCR and question-paper OCR are different problems, so this flow is
 * completely separate from the question pipeline. It does NOT import or call
 * `extractDrafts()` / segmentation / watermark / marker / numbering / draft
 * generation. It rasterises (PDF) or normalises (image) and recognises text with
 * its own Tesseract worker, then keeps ONLY answer-key pages and ignores
 * solution / explanation / worked-example pages.
 *
 * Output is plain text fed to the one canonical answer-key parser
 * (`services/answer-key.ts`), plus page-selection metadata for the preview UI.
 */

import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import type { PSM as Psm } from 'tesseract.js'; // type-only — no runtime load
import { countAnswerPairs } from './answer-key';

/* ───────────────────────────────────────── Page classification (pure) */

export type AnswerKeyPageType = 'ANSWER_KEY' | 'SOLUTION' | 'OTHER';

export interface AnswerKeyPageInfo {
  page: number; // 1-based
  type: AnswerKeyPageType;
  answerPairs: number;
  wordCount: number;
  solutionHits: number;
}

// Words that strongly indicate a worked SOLUTION / explanation page rather than a
// bare answer key. Substring, case-insensitive.
const SOLUTION_KEYWORDS = [
  'solution',
  'explanation',
  'explained',
  'hence',
  'therefore',
  'we get',
  'we have',
  'substitut',
  'step 1',
  'step-1',
  'from equation',
  'from the figure',
  'as shown',
  'sol.',
];

const countSolutionHits = (lower: string): number => {
  let hits = 0;
  for (const k of SOLUTION_KEYWORDS) if (lower.includes(k)) hits += 1;
  return hits;
};

/** Classify a single page from its OCR text. Pure — unit-testable. */
export const classifyAnswerKeyPage = (page: number, text: string): AnswerKeyPageInfo => {
  const t = text ?? '';
  const wordCount = t.split(/\s+/).filter((w) => w.length > 0).length;
  const answerPairs = countAnswerPairs(t);
  const solutionHits = countSolutionHits(t.toLowerCase());

  // SOLUTION: prose-heavy with solution cues and sparse answer rows.
  const isSolution = solutionHits >= 2 || (wordCount > 200 && answerPairs < 5);
  // ANSWER_KEY: dense grid of "N → answer" rows, little prose.
  const isKey = answerPairs >= 5 && solutionHits <= 1 && answerPairs * 6 >= wordCount;

  const type: AnswerKeyPageType = isKey ? 'ANSWER_KEY' : isSolution ? 'SOLUTION' : 'OTHER';
  return { page, type, answerPairs, wordCount, solutionHits };
};

export interface PageSelection {
  used: number[];
  ignored: Array<{ page: number; reason: string }>;
  classifications: AnswerKeyPageInfo[];
}

/**
 * Decide which pages are answer-key pages. Keeps ANSWER_KEY pages; once a
 * SOLUTION page appears the rest of the document is treated as the solutions
 * section and ignored. OTHER pages are kept only if they carry answer rows.
 * Fallback: if nothing qualifies but some page has answers, keep those — never
 * silently drop a legitimate small key.
 */
export const selectAnswerKeyPages = (pageTexts: string[]): PageSelection => {
  const classifications = pageTexts.map((t, i) => classifyAnswerKeyPage(i + 1, t));
  const used: number[] = [];
  const ignored: Array<{ page: number; reason: string }> = [];

  let solutionsStarted = false;
  for (const c of classifications) {
    if (solutionsStarted) {
      ignored.push({ page: c.page, reason: 'after solutions section' });
      continue;
    }
    if (c.type === 'SOLUTION') {
      solutionsStarted = true;
      ignored.push({ page: c.page, reason: 'solution / explanation page' });
      continue;
    }
    if (c.type === 'ANSWER_KEY' || c.answerPairs >= 3) {
      used.push(c.page);
    } else {
      ignored.push({ page: c.page, reason: 'no answer mappings' });
    }
  }

  // Fallback: never drop a real (small) key just because density was low.
  if (used.length === 0) {
    for (const c of classifications) {
      if (c.answerPairs >= 1) {
        used.push(c.page);
        const idx = ignored.findIndex((x) => x.page === c.page);
        if (idx >= 0) ignored.splice(idx, 1);
      }
    }
  }

  return { used, ignored, classifications };
};

/* ───────────────────────────────────────── OCR result + service */

export interface AnswerKeyOcrResult {
  /** Combined text of the ANSWER-KEY pages only (solutions excluded). */
  text: string;
  /** Per-page OCR text (all pages, pre-selection) — for debugging/telemetry. */
  pageTexts: string[];
  /** 1-based pages kept as answer-key pages. */
  pagesUsed: number[];
  /** 1-based pages ignored (solutions/explanations/empty), with the reason. */
  pagesIgnored: Array<{ page: number; reason: string }>;
}

// pdf-to-img is ESM-only; load it via Function-indirection so importing this
// module never bootstraps the ESM framework under CJS (same trick the engine
// uses, replicated here so we stay independent of the question pipeline).
type PdfFn = (
  input: Buffer,
  opts?: { scale?: number },
) => Promise<AsyncIterable<Buffer>>;
let pdfFn: PdfFn | null = null;
const loadPdf = async (): Promise<PdfFn> => {
  if (!pdfFn) {
    const esmImport = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>;
    const mod = (await esmImport('pdf-to-img')) as { pdf: PdfFn };
    pdfFn = mod.pdf;
  }
  return pdfFn;
};

const isPdf = (contentType: string): boolean => /pdf/i.test(contentType);

@Injectable()
export class AnswerKeyOcrService {
  private readonly logger = new Logger('AnswerKeyOcr');

  /** Rasterise (PDF) or normalise (image), OCR each page, keep answer-key pages. */
  async extractAnswerKey(bytes: Buffer, contentType: string): Promise<AnswerKeyOcrResult> {
    const pageBuffers = isPdf(contentType)
      ? await this.rasterizePdf(bytes)
      : [await this.normalizeImage(bytes)];

    // Lazy import so the pure page-filter helpers in this module can be used
    // (and unit-tested) without loading Tesseract. A dedicated, short-lived
    // worker — created and terminated per import — so the answer-key flow holds
    // no persistent resource and never shares state with the question pipeline's
    // Tesseract singleton.
    const { createWorker, PSM } = await import('tesseract.js');
    const worker = await createWorker('eng');
    const recognize = async (buf: Buffer, psm: Psm): Promise<string> => {
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await worker.recognize(buf);
      return data.text ?? '';
    };

    const bestOf = async (buf: Buffer, psms: Psm[]): Promise<string> => {
      let best = '';
      let bestScore = -1;
      for (const psm of psms) {
        const t = await recognize(buf, psm);
        const score = countAnswerPairs(t);
        if (score > bestScore) {
          bestScore = score;
          best = t;
        }
      }
      return best;
    };

    let pageTexts: string[];
    let selection: PageSelection;
    try {
      // Pass 1 — SINGLE_BLOCK is the reliable default for dense "N. (X)" answer
      // keys (AUTO layout analysis mis-segments multi-column grids into garbage).
      pageTexts = [];
      for (const buf of pageBuffers) pageTexts.push(await recognize(buf, PSM.SINGLE_BLOCK));
      selection = selectAnswerKeyPages(pageTexts);

      // Pass 1b — boxed / table / matrix keys where SINGLE_BLOCK finds nothing.
      // Retry every page across layout-tolerant modes and keep the densest.
      if (selection.used.length === 0) {
        const alt: string[] = [];
        for (const buf of pageBuffers) {
          alt.push(await bestOf(buf, [PSM.AUTO, PSM.SPARSE_TEXT, PSM.SINGLE_COLUMN]));
        }
        const altSel = selectAnswerKeyPages(alt);
        if (altSel.used.length > 0) {
          pageTexts = alt;
          selection = altSel;
        }
      }

      // Pass 2 — refine ONLY the chosen answer-key pages: try alternate modes and
      // keep whichever yields the most answer pairs (recovers boxed/grid cells the
      // primary mode under-read). Solution pages are never re-OCR'd.
      for (const p of selection.used) {
        const buf = pageBuffers[p - 1];
        let best = pageTexts[p - 1];
        let bestScore = countAnswerPairs(best);
        for (const psm of [PSM.AUTO, PSM.SPARSE_TEXT]) {
          const t = await recognize(buf, psm);
          const score = countAnswerPairs(t);
          if (score > bestScore) {
            bestScore = score;
            best = t;
          }
        }
        pageTexts[p - 1] = best;
      }
    } finally {
      await worker.terminate();
    }

    const text = selection.used.map((p) => pageTexts[p - 1]).join('\n');
    this.logger.log(
      `answer-key OCR: ${pageTexts.length} page(s), used=[${selection.used.join(',')}] ` +
        `ignored=${selection.ignored.length}`,
    );
    return {
      text,
      pageTexts,
      pagesUsed: selection.used,
      pagesIgnored: selection.ignored,
    };
  }

  /** IAnswerKeyOcr compatibility — text of the answer-key pages only. */
  async extractText(bytes: Buffer, contentType: string): Promise<string> {
    return (await this.extractAnswerKey(bytes, contentType)).text;
  }

  private async rasterizePdf(bytes: Buffer): Promise<Buffer[]> {
    const pdf = await loadPdf();
    const doc = await pdf(bytes, { scale: 2 });
    const out: Buffer[] = [];
    for await (const page of doc) out.push(page);
    return out;
  }

  private async normalizeImage(bytes: Buffer): Promise<Buffer> {
    // OCR-friendly normalisation for answer-key images: grayscale + contrast
    // normalise + upscale small scans (boxed/grid cells need enough pixels) +
    // light sharpen, flattened to PNG. No segmentation, no watermark logic — just
    // a clean page for Tesseract.
    const meta = await sharp(bytes).metadata();
    let pipeline = sharp(bytes).grayscale().normalize();
    // Only upscale GENUINELY small scans (sharpen helps there but adds artifacts
    // on already-large clean renders, which slightly degraded recognition).
    if ((meta.width ?? 0) > 0 && (meta.width as number) < 1000) {
      pipeline = pipeline.resize({ width: 1600 }).sharpen();
    }
    return pipeline.png().toBuffer();
  }
}
