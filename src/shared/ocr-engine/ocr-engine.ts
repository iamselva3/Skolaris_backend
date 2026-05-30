/*
 * Framework-agnostic OCR engine. Extracted verbatim from the original
 * standalone scripts/ocr-worker.ts so the EXACT same extraction logic backs
 * BOTH consumers:
 *   - the standalone BullMQ worker (scripts/ocr-worker.ts, npm run ocr:real)
 *   - the in-process NestJS consumer (src/shared/workers/ocr.processor.ts)
 *
 * It has NO NestJS / DI dependencies — only env, fetch, tesseract.js and
 * pdf-to-img — so importing it never bootstraps the framework. Transport
 * (the HMAC HTTP callback) and queue wiring deliberately stay OUT of here:
 * the standalone worker keeps POSTing the signed callback; the in-process
 * consumer calls HandleOcrCallbackUseCase directly. Behaviour is identical
 * either way because both feed the same draft shape into the same code path.
 */
import { createWorker as createTesseractWorker, type Worker as TesseractWorker } from 'tesseract.js';

export interface OcrEngineDraft {
  position: number;
  text: string;
  detectedType: string;
  options?: Array<{ label: string; isCorrect?: boolean }>;
  confidence: number;
}

/**
 * Raw routing signal, populated ONLY when extractDrafts is called with
 * { withWords: true } (the handwriting-fallback path). Consumers that ignore it
 * — i.e. every caller today — are unaffected; the field is absent by default.
 */
export interface OcrSignalRaw {
  text: string;
  pageCount: number;
  wordConfidences: number[];
  sentinel: boolean; // the "no extractable text" fallback fired
}

export interface OcrEngineResult {
  providerUsed: string;
  overallConfidence: number;
  drafts: OcrEngineDraft[];
  signalRaw?: OcrSignalRaw;
}

/* ─────────────────────────────────────────── Tesseract: lazy-singleton */

let tesseractPromise: Promise<TesseractWorker> | null = null;

const getTesseract = (): Promise<TesseractWorker> => {
  if (!tesseractPromise) {
    // eslint-disable-next-line no-console
    console.log('[ocr-engine] initializing Tesseract (eng) — first run downloads ~10MB model…');
    tesseractPromise = createTesseractWorker('eng', 1, {
      logger: (m) => {
        if (m.status === 'recognizing text' || m.status === 'loading tesseract core') return;
        // eslint-disable-next-line no-console
        console.log(`[tesseract] ${m.status}${m.progress ? ` ${Math.round(m.progress * 100)}%` : ''}`);
      },
    });
  }
  return tesseractPromise;
};

/**
 * Drop the (possibly poisoned) Tesseract singleton so the next job
 * re-initialises a clean one. Used by the standalone worker's uncaught-error
 * resilience net and by the in-process processor's per-job guard — never let a
 * malformed image permanently wedge the consumer.
 */
export const resetTesseract = (): void => {
  const p = tesseractPromise;
  tesseractPromise = null;
  if (p) void p.then((w) => w.terminate()).catch(() => undefined);
};

/** Terminate the worker on graceful shutdown. */
export const shutdownTesseract = async (): Promise<void> => {
  const p = tesseractPromise;
  tesseractPromise = null;
  if (p) await (await p).terminate().catch(() => undefined);
};

/* ─────────────────────────────────────────── Storage fetch */

const inferMimeFromKey = (storageKey: string): string => {
  const ext = storageKey.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'heic') return 'image/heic';
  return 'image/jpeg';
};

/**
 * Fetch object bytes through the backend storage read-proxy (StorageReadController),
 * which streams them from the active R2/S3 adapter. This is DI-less and used ONLY
 * by the standalone BullMQ worker (scripts/ocr-worker.ts); the in-process NestJS
 * consumer reads bytes directly from the injected adapter (no HTTP, no env).
 *
 * Provider-agnostic: the read host comes from STORAGE_READ_BASE_URL (e.g.
 * `https://<api-host>/api`) — NOT from any GCS_* variable. There is no localhost
 * fallback: an unset base fails fast so a misconfigured worker can never silently
 * hit a dead emulator host.
 */
export const fetchObjectBytes = async (
  storageKey: string,
): Promise<{ bytes: Buffer; mime: string }> => {
  const base = (process.env.STORAGE_READ_BASE_URL || '').replace(/\/+$/, '');
  if (!base) {
    throw new Error(
      'STORAGE_READ_BASE_URL is not set. The standalone OCR worker needs the backend ' +
        'read-proxy base URL (e.g. https://<api-host>/api) to fetch uploaded files.',
    );
  }
  // The read-proxy keys objects by storageKey alone; the bucket segment is
  // cosmetic (it ignores :bucket), so AWS_S3_BUCKET or a placeholder both work.
  const bucket = process.env.AWS_S3_BUCKET || 'uploads';
  const url = `${base}/download/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(storageKey)}?alt=media`;
  const t0 = Date.now();
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Storage fetch ${res.status} ${res.statusText} for ${url}`);
  }
  const mime = res.headers.get('content-type') ?? inferMimeFromKey(storageKey);
  const ab = await res.arrayBuffer();
  // eslint-disable-next-line no-console
  console.log(`[ocr-engine] fetched ${ab.byteLength} bytes (${mime}) in ${Date.now() - t0}ms`);
  return { bytes: Buffer.from(ab), mime };
};

/* ─────────────────────────────────────────── OCR + parse */

const QUESTION_WORDS = /^\s*(which|what|how|why|when|where|who|explain|describe|name|state|find|calculate|determine|identify|select|choose|consider)\b/i;
const numberedLineRe = /^(\d{1,2})\s*([.):])\s*(.*)$/;
const qPrefixRe = /^Q\s*\.?\s*(\d{1,2})\s*[.:)]\s*(.*)$/i;
const letteredOptionRe = /^\(?([a-d])\)?\s*[.):]\s*(.+)$/i;

const inferType = (stem: string, optionCount: number): string => {
  const s = stem.toLowerCase();
  if (/\b(true or false|\(t\/f\)|t or f)\b/.test(s)) return 'TRUE_FALSE';
  if (/\b(select all|all that apply|multiple correct)\b/.test(s)) return 'MULTIPLE_CHOICE';
  if (/____+|\bfill in the blank/.test(s)) return 'FILL_BLANK';
  if (optionCount >= 2) return 'SINGLE_CHOICE';
  return 'DESCRIPTIVE';
};

/**
 * Sequential-context heuristic parser. Walks each line deciding
 * question / option / continuation based on shape + the currently-open
 * question's option counter. (Ported unchanged from the original worker.)
 */
export const parseDrafts = (rawText: string, overallConfidence: number): OcrEngineDraft[] => {
  const lines = rawText
    .replace(/\r\n/g, '\n')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  interface Q {
    stem: string[];
    options: string[];
  }
  const out: Q[] = [];
  const state: { current: Q | null } = { current: null };

  const openNewQuestion = (stemSeed: string): void => {
    if (state.current) out.push(state.current);
    state.current = { stem: stemSeed ? [stemSeed] : [], options: [] };
  };

  const pushOption = (body: string): void => {
    if (!state.current) {
      state.current = { stem: [], options: [body] };
      return;
    }
    state.current.options.push(body);
  };

  for (const line of lines) {
    const qp = qPrefixRe.exec(line);
    if (qp) {
      openNewQuestion(qp[2]);
      continue;
    }

    const nm = numberedLineRe.exec(line);
    if (nm) {
      const num = Number(nm[1]);
      const marker = nm[2];
      const body = nm[3];

      if (marker === ')') {
        openNewQuestion(body);
        continue;
      }

      if (state.current) {
        const expected = state.current.options.length + 1;
        if (num === expected && state.current.options.length < 6) {
          pushOption(body);
          continue;
        }
      }
      const looksLikeStem =
        body.length > 25 || body.trimEnd().endsWith('?') || QUESTION_WORDS.test(body);
      if (looksLikeStem) {
        openNewQuestion(body);
      } else {
        pushOption(body);
      }
      continue;
    }

    const lp = letteredOptionRe.exec(line);
    if (lp) {
      pushOption(lp[2]);
      continue;
    }

    if (!state.current) continue;
    if (state.current.options.length > 0) {
      state.current.options[state.current.options.length - 1] += ' ' + line;
    } else {
      state.current.stem.push(line);
    }
  }
  if (state.current) out.push(state.current);

  const MAX_DRAFTS = 20;
  return out.slice(0, MAX_DRAFTS).map((q, i) => {
    const stem = q.stem.join(' ').replace(/\s+/g, ' ').trim();
    const opts = q.options
      .map((label) => ({ label: label.replace(/\s+/g, ' ').trim(), isCorrect: false }))
      .filter((o) => o.label.length > 0);
    return {
      position: i,
      text: stem,
      detectedType: inferType(stem, opts.length),
      options: opts.length >= 2 ? opts : undefined,
      confidence: overallConfidence,
    };
  });
};

interface TWord {
  confidence?: number;
}
interface TLine {
  words?: TWord[];
}
interface TParagraph {
  lines?: TLine[];
}
interface TBlock {
  paragraphs?: TParagraph[];
}
interface TData {
  words?: TWord[];
  blocks?: TBlock[];
}

/** Flatten per-word confidences from a tesseract result (defensive across shapes). */
const collectWordConfidences = (data: unknown): number[] => {
  const d = data as TData | null;
  const out: number[] = [];
  if (!d) return out;
  if (Array.isArray(d.words) && d.words.length > 0) {
    for (const w of d.words) if (typeof w.confidence === 'number') out.push(w.confidence);
    return out;
  }
  for (const b of d.blocks ?? []) {
    for (const p of b.paragraphs ?? []) {
      for (const l of p.lines ?? []) {
        for (const w of l.words ?? []) {
          if (typeof w.confidence === 'number') out.push(w.confidence);
        }
      }
    }
  }
  return out;
};

const runOcr = async (
  bytes: Buffer,
  withWords = false,
): Promise<{ text: string; confidence: number; wordConfidences: number[] }> => {
  const t = await getTesseract();
  const t0 = Date.now();
  // Default path (withWords=false) calls recognize EXACTLY as before — text and
  // confidence are byte-identical. Word-level data is opt-in (routing only) via
  // the output flag and never alters data.text / data.confidence.
  const { data } = withWords
    ? await t.recognize(bytes, {}, { blocks: true })
    : await t.recognize(bytes);
  // eslint-disable-next-line no-console
  console.log(
    `[ocr-engine] tesseract done in ${Date.now() - t0}ms, ${data.text.length} chars, confidence=${Math.round(data.confidence)}%`,
  );
  return {
    text: data.text,
    confidence: data.confidence / 100,
    wordConfidences: withWords ? collectWordConfidences(data) : [],
  };
};

/* ─────────────────────────────────────────── PDF: rasterize + OCR each page */

interface PdfDoc extends AsyncIterable<Buffer> {
  length: number;
  destroy(): Promise<void>;
}
type PdfToImg = (input: Buffer, opts?: { scale?: number }) => Promise<PdfDoc>;
let pdfToImgFn: PdfToImg | null = null;

/**
 * pdf-to-img is ESM-only. We load it via a Function-indirection dynamic import
 * so that TypeScript's commonjs target does NOT downlevel `import()` to
 * `require()` (which would fail for a pure-ESM package). This is a genuine
 * runtime ES dynamic import and works under both ts-node and compiled dist.
 */
const esmImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>;

const getPdfToImg = async (): Promise<PdfToImg> => {
  if (!pdfToImgFn) {
    const mod = (await esmImport('pdf-to-img')) as { pdf: PdfToImg };
    pdfToImgFn = mod.pdf;
  }
  return pdfToImgFn;
};

const ocrPdf = async (
  bytes: Buffer,
  withWords = false,
): Promise<{ text: string; confidence: number; pageCount: number; wordConfidences: number[] }> => {
  const t0 = Date.now();
  const pdf = await getPdfToImg();
  const doc = await pdf(bytes, { scale: 2 });

  let combined = '';
  let confSum = 0;
  let pageCount = 0;
  const wordConfidences: number[] = [];
  try {
    for await (const pageImage of doc) {
      pageCount += 1;
      const pageT0 = Date.now();
      const { text, confidence, wordConfidences: pageWords } = await runOcr(pageImage, withWords);
      confSum += confidence;
      if (withWords && pageWords.length > 0) wordConfidences.push(...pageWords);
      combined += (combined ? '\n\n' : '') + text.trim();
      // eslint-disable-next-line no-console
      console.log(`[ocr-engine] pdf page ${pageCount}: ${text.length} chars (${Date.now() - pageT0}ms)`);
    }
  } finally {
    await doc.destroy().catch(() => {
      /* swallow shutdown errors */
    });
  }

  const avgConf = pageCount > 0 ? confSum / pageCount : 0;
  // eslint-disable-next-line no-console
  console.log(
    `[ocr-engine] pdf done: ${pageCount} page(s), ${combined.length} chars total, avgConfidence=${Math.round(avgConf * 100)}%, ${Date.now() - t0}ms`,
  );
  return { text: combined, confidence: avgConf, pageCount, wordConfidences };
};

/* ─────────────────────────────────────────── Orchestration */

/**
 * Run OCR + parse on the fetched bytes, reproducing the original worker's
 * image-vs-PDF branch and empty-result fallbacks exactly. Pure: it does not
 * fetch, persist, or POST anything.
 */
export const extractDrafts = async (
  bytes: Buffer,
  mime: string,
  opts: { withWords?: boolean } = {},
): Promise<OcrEngineResult> => {
  const withWords = opts.withWords === true;

  if (mime === 'application/pdf') {
    const { text, confidence, pageCount, wordConfidences } = await ocrPdf(bytes, withWords);
    let sentinel = false;
    let drafts = parseDrafts(text, confidence);
    if (drafts.length === 0) {
      sentinel = true;
      drafts = [
        {
          position: 0,
          text: text.slice(0, 2000).trim() || '(OCR produced no extractable text from this PDF)',
          detectedType: 'DESCRIPTIVE',
          confidence,
        },
      ];
    }
    const result: OcrEngineResult = {
      providerUsed: `tesseract:pdf(${pageCount}p)`,
      overallConfidence: confidence,
      drafts,
    };
    if (withWords) result.signalRaw = { text, pageCount, wordConfidences, sentinel };
    return result;
  }

  const { text, confidence, wordConfidences } = await runOcr(bytes, withWords);
  let sentinel = false;
  let drafts = parseDrafts(text, confidence);
  if (drafts.length === 0) {
    sentinel = true;
    drafts = [
      {
        position: 0,
        text: text.slice(0, 2000).trim() || '(OCR produced no extractable text)',
        detectedType: 'DESCRIPTIVE',
        confidence,
      },
    ];
  }
  const result: OcrEngineResult = { providerUsed: 'tesseract', overallConfidence: confidence, drafts };
  if (withWords) result.signalRaw = { text, pageCount: 1, wordConfidences, sentinel };
  return result;
};
