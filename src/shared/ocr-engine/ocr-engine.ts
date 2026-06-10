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
import sharp from 'sharp';
import {
  createScheduler,
  createWorker as createTesseractWorker,
  type Scheduler,
  type Worker as TesseractWorker,
} from 'tesseract.js';
import {
  classifyAllPages,
  isExtractableQuestionPage,
  summarizeClassifications,
  type PageClassification,
} from './page-classification';
import { reorderByColumns, type OcrWordBox, type ReorderLayout } from './column-reorder';
import { ocrPdfViaPaddle, type PageFigureRef } from './paddle-printed-http';

/** Per-page layout audit, persisted on OcrJob.layoutMetadata. */
export interface PageLayoutInfo {
  pageNumber: number;
  layout: ReorderLayout;
  splitX: number | null;
  confidence: number;
}

/**
 * Visual asset (figure / diagram / table / graph) cropped from the source page
 * and uploaded to object storage. Slice 2.3.
 */
export interface OcrEngineFigure {
  storageKey: string;
  kind: 'figure' | 'table' | 'graph' | 'formula';
  boundingBox: { x0: number; y0: number; x1: number; y1: number; page: number };
  caption?: string;
}

/**
 * Phase B — table carrier. When PP-Structure detects a TABLE region attached
 * to this draft, its HTML structure is preserved (rows/cols/cells) so the FE
 * can render the table verbatim instead of seeing flattened text.
 */
export interface OcrTable {
  /** PP-Structure-extracted HTML, typically <table><tr><td>…</td></tr></table>. */
  html: string;
  /** R2 storage key of the table image crop (rendered fallback when HTML is partial). */
  storageKey: string;
  boundingBox: { x0: number; y0: number; x1: number; y1: number; page: number };
}

export interface OcrEngineDraft {
  position: number;
  text: string;
  detectedType: string;
  options?: Array<{ label: string; isCorrect?: boolean }>;
  confidence: number;
  /** Page number (1-based) in the source PDF/image this draft came from. */
  sourcePageNumber?: number;
  /** First/last page when a question spans multiple pages (rare). */
  spanPageStart?: number;
  spanPageEnd?: number;
  /** Optional solution/explanation block split out from the stem. */
  solutionText?: string;
  /** Figure crops detected on the same page, associated to this draft. Slice 2.3. */
  figures?: OcrEngineFigure[];
  /** Phase B — single table HTML for the common one-table-per-question case.
   *  Convenience accessor; the canonical list lives in `tables`. */
  tableHtml?: string;
  /** Phase B — preserved tables on this draft (rows/cols/cells via PP-Structure). */
  tables?: OcrTable[];
  /** Visual-preservation fallback — set when this draft had garbage stretches
   *  stripped from its OCR text (likely diagram pixels mis-read as characters).
   *  When true the FE should display attached figures prominently and warn the
   *  reviewer that the OCR text may be incomplete. */
  needsImageReview?: boolean;
  /** Question-snapshot fallback — R2 storage key of a cropped page region
   *  covering the source question. When set, the FE renders this image
   *  prominently above (or instead of) the OCR text. Screenshot-first
   *  segmentation makes this the PRIMARY content for every Visual draft. */
  questionSnapshotKey?: string;
  /** Best-effort number of answer slots on the crop (2..6); advisory only. */
  optionCount?: number;
  /** The question number detected at the top of this crop (e.g. 103), parsed from
   *  the question-start marker. Drives coverage/missing-number reporting and makes
   *  answer-key mapping reliable. Null when no number could be read. */
  questionNumber?: number | null;
  /** 0-based reading column this crop came from, and how many columns the page
   *  had. Used only to pinpoint WHERE a missing question should have been (the
   *  segmentation diagnostic: page + Left/Right column). */
  sourceColumn?: number;
  sourceColumnCount?: number;
  /** True when the crop has NO question number, stem, or marker — a diagram
   *  fragment / watermark / footer slice. Flagged for review and NOT counted as a
   *  real question in the coverage report. */
  invalidCrop?: boolean;
  /** Screenshot-first classification of the cropped block — one of MCQ /
   *  TRUE_FALSE / ASSERTION_REASON / MATCH_THE_FOLLOWING / FILL_IN_THE_BLANK /
   *  DESCRIPTIVE / DIAGRAM_BASED / UNKNOWN. Advisory: hints the teacher's answer
   *  mode in the review UI and drives the boundary-merge / confidence logic. */
  questionClass?: string;
  /** Bounding box of the question region on the source page (image pixels). */
  sourceCoordinates?: { x0: number; y0: number; x1: number; y1: number };
  /** Phase C — opaque pointers back to the source regions that produced this
   *  draft. Populated when the region-based draft builder is enabled; consumers
   *  may treat as a hint for re-rendering or audit. */
  regionIds?: string[];
  sourceRegionPointers?: string[];
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
  /** Per-page classification (PDFs only). Absent for single-image extractions. */
  pageMetadata?: PageClassification[];
  /** Per-page layout detection (single/two-column). Absent if reorder was off. */
  layoutMetadata?: PageLayoutInfo[];
}

/* ─────────────────────────────────────────── Tesseract: lazy-singleton */

let tesseractPromise: Promise<TesseractWorker> | null = null;
let schedulerPromise: Promise<Scheduler> | null = null;

// Shared worker config so the single-worker singleton AND every pooled worker
// are created IDENTICALLY (same lang / OEM / logger). The pool is a SCHEDULING
// change only — recognition behaviour is never altered.
const tesseractLogger = (m: { status: string; progress?: number }): void => {
  if (m.status === 'recognizing text' || m.status === 'loading tesseract core') return;
  // eslint-disable-next-line no-console
  console.log(`[tesseract] ${m.status}${m.progress ? ` ${Math.round(m.progress * 100)}%` : ''}`);
};
const createSharedWorker = (): Promise<TesseractWorker> =>
  createTesseractWorker('eng', 1, { logger: tesseractLogger });

const getTesseract = (): Promise<TesseractWorker> => {
  if (!tesseractPromise) {
    // eslint-disable-next-line no-console
    console.log('[ocr-engine] initializing Tesseract (eng) — first run downloads ~10MB model…');
    tesseractPromise = createSharedWorker();
  }
  return tesseractPromise;
};

/**
 * Bounded Tesseract worker POOL for OCR_PARALLEL_PAGES. Lazily builds `workers`
 * IDENTICAL workers behind a tesseract.js Scheduler so independent pages can be
 * recognised concurrently. The scheduler only decides WHICH worker runs a given
 * page — same image → same result — so output is unchanged versus the singleton.
 */
const getScheduler = (workers: number): Promise<Scheduler> => {
  if (!schedulerPromise) {
    schedulerPromise = (async () => {
      const sched = createScheduler();
      // Create all workers CONCURRENTLY so the one-time pool startup is ~1×
      // instead of ~N× the single-worker init. Worker config is identical
      // regardless of creation order, and the scheduler dispatches each page to
      // whichever worker is free — recognition (hence OCR output) is unaffected.
      const created = await Promise.all(
        Array.from({ length: workers }, () => createSharedWorker()),
      );
      for (const w of created) sched.addWorker(w);
      // eslint-disable-next-line no-console
      console.log(`[ocr-engine] tesseract scheduler ready (${workers} worker(s))`);
      return sched;
    })();
  }
  return schedulerPromise;
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
  const s = schedulerPromise;
  schedulerPromise = null;
  if (s) void s.then((sched) => sched.terminate()).catch(() => undefined);
};

/** Terminate the worker (and pool) on graceful shutdown. */
export const shutdownTesseract = async (): Promise<void> => {
  const p = tesseractPromise;
  tesseractPromise = null;
  if (p) await (await p).terminate().catch(() => undefined);
  const s = schedulerPromise;
  schedulerPromise = null;
  if (s) await (await s).terminate().catch(() => undefined);
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

const QUESTION_WORDS =
  /^\s*(which|what|how|why|when|where|who|explain|describe|name|state|find|calculate|determine|identify|select|choose|consider)\b/i;

/**
 * Inline numbered-option splitter for NEET-style papers where options are
 * `(1) … (2) … (3) … (4) …` and tesseract emits them on a single continuation
 * line (especially after column reorder of narrow columns).
 *
 * Strategy: find every `(N)` marker for N ∈ {1,2,3,4} where it is followed by
 * a space and at least one non-`(` character before the next marker (or end).
 * If the markers form a non-decreasing sequence starting at 1 and reaching at
 * least 3, segment the input into { stemBefore, options[] }. Returns null if
 * the pattern doesn't fit (no destructive change).
 *
 * Tolerates tesseract OCR errors on the parens: `(1)` may appear as `(1)`,
 * `1)`, `(I)` (capital-I confusion), `(l)` (lowercase-L). We accept those
 * variants but keep the numeric content as the marker identity. We do NOT
 * accept stray digits embedded in text (must be paren-flanked OR start-of-line).
 */
const INLINE_NUMBERED_OPTION_RE = /\(?\s*([1-4Il])\s*\)\s+/g;
const extractInlineNumberedOptions = (text: string): { stem: string; options: string[] } | null => {
  // Quick reject — if the text contains fewer than two distinct paren-numbered
  // markers, no point scanning.
  if (text.length < 20) return null;

  const markers: Array<{ idx: number; n: number; matchLen: number }> = [];
  INLINE_NUMBERED_OPTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_NUMBERED_OPTION_RE.exec(text)) !== null) {
    const raw = m[1];
    const n = raw === 'I' || raw === 'l' ? 1 : Number(raw);
    if (Number.isNaN(n) || n < 1 || n > 4) continue;
    markers.push({ idx: m.index, n, matchLen: m[0].length });
  }
  if (markers.length < 3) return null;

  // Keep only markers that form a strictly increasing 1→2→3(→4) run.
  const run: typeof markers = [];
  let expected = 1;
  for (const mk of markers) {
    if (mk.n === expected) {
      run.push(mk);
      expected += 1;
      if (expected > 4) break;
    }
  }
  if (run.length < 3) return null;

  // Stem is everything before the first marker.
  const stem = text.slice(0, run[0].idx).trim();
  if (stem.length < 5) return null;
  const options: string[] = [];
  for (let i = 0; i < run.length; i += 1) {
    const start = run[i].idx + run[i].matchLen;
    const end = i + 1 < run.length ? run[i + 1].idx : text.length;
    const opt = text.slice(start, end).trim();
    if (opt.length > 0) options.push(opt);
  }
  if (options.length < 3) return null;
  return { stem, options };
};
/**
 * Visual-preservation defense-in-depth: strip "garbage stretches" — runs of
 * 4+ consecutive 1-2-char tokens where AT LEAST ONE token contains zero
 * alphabetic characters. These are the residual diagram-pixel OCR artifacts
 * that survive the Python region-quality scorer (the per-region filter
 * catches whole regions; this catches in-line leakage inside otherwise-clean
 * text regions, e.g. "withstand without break-down is called its 3¢ c @ 5 ").
 *
 * Conservative by design — short alphabetic stretches like "of an A B test"
 * stay intact because they don't contain any pure-symbol token.
 *
 * Returns the cleaned string AND a boolean flag indicating whether any
 * stretch was stripped (caller uses this to set draft.needsImageReview).
 */
const stripGarbageStretches = (text: string): { cleaned: string; stripped: boolean } => {
  if (!text) return { cleaned: text, stripped: false };
  const tokens = text.split(/\s+/);
  const out: string[] = [];
  let stripped = false;
  let i = 0;
  while (i < tokens.length) {
    let j = i;
    while (j < tokens.length && tokens[j].length <= 2) j += 1;
    const stretchLen = j - i;
    if (stretchLen >= 4) {
      let hasSymbolOnlyToken = false;
      for (let k = i; k < j; k += 1) {
        if (!/[A-Za-z]/.test(tokens[k])) {
          hasSymbolOnlyToken = true;
          break;
        }
      }
      if (hasSymbolOnlyToken) {
        stripped = true;
        i = j;
        continue;
      }
    }
    out.push(tokens[i]);
    i += 1;
  }
  return { cleaned: out.join(' '), stripped };
};

// Allow up to 3-digit question numbers (NEET papers go to 180+) and the longer
// "Question" / "QNo" prefixes that some coaching-centre templates use.
const numberedLineRe = /^(\d{1,3})\s*([.):])\s*(.*)$/;
// Priority-1 fix (A1): inline-marker safety net. When two questions get fused
// onto one OCR line (column reorder failure, single-column wrap glitch,
// watermark drag, …) the start-of-line regex above misses the buried marker
// and both questions collapse into one draft. This RE finds inline markers
// that look like a real new-question start: a 1-3 digit number + `.` / `:`
// preceded by whitespace, followed by space + Capital + lowercase (sentence
// shape). Lookahead-only — the marker itself stays in the resulting line so
// numberedLineRe can re-match after the split. Long lines only (≥80 chars)
// keep numbered lists inside short stems ("Step 1. Boil water.") safe.
const INLINE_QUESTION_MARKER_RE = /\s(?=(\d{1,3})\s*[.):]\s+[A-Z][a-z])/g;
const splitInlineQuestionMarkers = (line: string): string[] => {
  if (line.length < 80) return [line];
  const indices: number[] = [];
  INLINE_QUESTION_MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_QUESTION_MARKER_RE.exec(line)) !== null) {
    if (m.index === 0) continue; // start-of-line already handled
    indices.push(m.index + 1); // skip the leading whitespace match position
  }
  if (indices.length === 0) return [line];
  const chunks: string[] = [];
  let cursor = 0;
  for (const idx of indices) {
    const chunk = line.slice(cursor, idx).trim();
    if (chunk.length > 0) chunks.push(chunk);
    cursor = idx;
  }
  const tail = line.slice(cursor).trim();
  if (tail.length > 0) chunks.push(tail);
  return chunks.length > 0 ? chunks : [line];
};
const qPrefixRe = /^(?:Question|Q\.?\s*No\.?|Q)\s*\.?\s*(\d{1,3})\s*[.:)]\s*(.*)$/i;
const letteredOptionRe = /^\(?([a-d])\)?\s*[.):]\s*(.+)$/i;
// Solution / explanation / answer markers that appear AFTER a question's options
// in some papers. Lines starting with these split the question's solutionText
// out from the stem so reviewers see "Q1 stem | options | solution" cleanly.
const solutionMarkerRe =
  /^\s*(?:solution|explanation|sol(?:n)?|ans(?:wer)?|hint)\s*[:.\-)]\s*(.*)$/i;

const inferType = (stem: string, optionCount: number): string => {
  const s = stem.toLowerCase();
  if (/\b(true or false|\(t\/f\)|t or f)\b/.test(s)) return 'TRUE_FALSE';
  if (/\b(select all|all that apply|multiple correct)\b/.test(s)) return 'MULTIPLE_CHOICE';
  if (/____+|\bfill in the blank/.test(s)) return 'FILL_BLANK';
  if (optionCount >= 2) return 'SINGLE_CHOICE';
  return 'DESCRIPTIVE';
};

/**
 * Hard ceiling to guard against pathological input (e.g. an OCR'd OMR sheet
 * misclassified as a QUESTION page producing thousands of "options"). 180 NEET
 * questions × ~5 papers per upload is the practical upper bound today; 1000 is
 * a generous safety net. The original 20-draft cap was the bug — it silently
 * truncated long papers — not the existence of a cap.
 */
const MAX_DRAFTS_PER_CALL = 1000;

/**
 * Sequential-context heuristic parser. Walks each line deciding
 * question / option / continuation / solution based on shape + the currently-
 * open question's option counter. Output drafts may carry sourcePageNumber if
 * the caller passes opts.pageNumber (per-page parsing path).
 *
 * Stays backward-compatible with the single-string call site: when opts is
 * omitted, behaviour matches the pre-refactor parser apart from the lifted
 * MAX_DRAFTS=20 cap (replaced with the generous safety ceiling above) and the
 * new solutionText/extended-marker handling, which only enrich the result.
 *
 * WITHIN-PAGE ORDERING: drafts come out in the order they appear in `rawText`
 * — the function is a pure single-pass scan over the lines and pushes a new
 * question to `out` as soon as the next Q-marker is encountered. There is no
 * reordering or sort. Combined with the page-ascending iteration in
 * `extractDrafts` (see ORDERING GUARANTEE there), this means global draft
 * position is page-ascending then within-page-document-order, regardless of
 * how fast individual pages OCR.
 */
export const parseDrafts = (
  rawText: string,
  overallConfidence: number,
  opts: { pageNumber?: number; positionOffset?: number } = {},
): OcrEngineDraft[] => {
  const lines = rawText
    .replace(/\r\n/g, '\n')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    // Priority-1 fix (A1): split any line that looks like two fused questions.
    // Pure flatMap — a clean line passes through unchanged.
    .flatMap((l) => splitInlineQuestionMarkers(l));

  interface Q {
    stem: string[];
    options: string[];
    solution: string[];
    /** True once a solution/explanation marker has been seen for this Q. */
    inSolution: boolean;
  }
  const out: Q[] = [];
  const state: { current: Q | null } = { current: null };

  const newQ = (stemSeed: string): Q => ({
    stem: stemSeed ? [stemSeed] : [],
    options: [],
    solution: [],
    inSolution: false,
  });

  const openNewQuestion = (stemSeed: string): void => {
    if (state.current) out.push(state.current);
    state.current = newQ(stemSeed);
  };

  const pushOption = (body: string): void => {
    if (!state.current) {
      state.current = { stem: [], options: [body], solution: [], inSolution: false };
      return;
    }
    state.current.options.push(body);
  };

  for (const line of lines) {
    // 1. Solution / explanation marker — switches the current question into
    //    solution-collection mode for the remainder of its lines.
    const sm = solutionMarkerRe.exec(line);
    if (sm && state.current) {
      state.current.inSolution = true;
      if (sm[1]) state.current.solution.push(sm[1]);
      continue;
    }

    // 2. Explicit "Q1." / "Question 1:" / "QNo. 1." prefix — opens a new Q.
    const qp = qPrefixRe.exec(line);
    if (qp) {
      openNewQuestion(qp[2]);
      continue;
    }

    // 3. Numbered line — either an option ("1)") or a new stem ("1.").
    const nm = numberedLineRe.exec(line);
    if (nm) {
      const num = Number(nm[1]);
      const marker = nm[2];
      const body = nm[3];

      if (marker === ')') {
        openNewQuestion(body);
        continue;
      }

      if (state.current && !state.current.inSolution) {
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

    // 4. Lettered option "(A) ..."
    const lp = letteredOptionRe.exec(line);
    if (lp) {
      pushOption(lp[2]);
      continue;
    }

    // 5. Continuation line — append to the last open section.
    if (!state.current) continue;
    if (state.current.inSolution) {
      state.current.solution.push(line);
    } else if (state.current.options.length > 0) {
      state.current.options[state.current.options.length - 1] += ' ' + line;
    } else {
      state.current.stem.push(line);
    }
  }
  if (state.current) out.push(state.current);

  const positionOffset = opts.positionOffset ?? 0;
  return out.slice(0, MAX_DRAFTS_PER_CALL).map((q, i) => {
    let stem = q.stem.join(' ').replace(/\s+/g, ' ').trim();
    let opts2 = q.options
      .map((label) => ({ label: label.replace(/\s+/g, ' ').trim(), isCorrect: false }))
      .filter((o) => o.label.length > 0);

    // NEET-style inline options: when the line-by-line scan didn't pick out
    // distinct option lines (typical for tight 2-column layouts where (1)/(2)/
    // (3)/(4) appear within a continuation line), post-process the stem text
    // for paren-numbered markers and split them out.
    if (opts2.length < 2) {
      const inline = extractInlineNumberedOptions(stem);
      if (inline) {
        stem = inline.stem;
        opts2 = inline.options.map((label) => ({
          label: label.replace(/\s+/g, ' ').trim(),
          isCorrect: false,
        }));
      }
    }

    const solution = q.solution.join(' ').replace(/\s+/g, ' ').trim();

    // Visual-preservation defense-in-depth: strip garbage stretches from the
    // final stem + options. If any stretch was stripped, flag the draft so
    // the FE can show "review carefully" UI + the attached figure crops the
    // Python region scorer preserved upstream.
    const stemSweep = stripGarbageStretches(stem);
    let needsImageReview = stemSweep.stripped;
    stem = stemSweep.cleaned;
    opts2 = opts2.map((o) => {
      const r = stripGarbageStretches(o.label);
      if (r.stripped) needsImageReview = true;
      return { ...o, label: r.cleaned };
    });

    const draft: OcrEngineDraft = {
      position: positionOffset + i,
      text: stem,
      detectedType: inferType(stem, opts2.length),
      options: opts2.length >= 2 ? opts2 : undefined,
      confidence: overallConfidence,
    };
    if (opts.pageNumber !== undefined) {
      draft.sourcePageNumber = opts.pageNumber;
      draft.spanPageStart = opts.pageNumber;
      draft.spanPageEnd = opts.pageNumber;
    }
    if (solution) draft.solutionText = solution;
    if (needsImageReview) draft.needsImageReview = true;
    return draft;
  });
};

interface TBbox {
  x0?: number;
  y0?: number;
  x1?: number;
  y1?: number;
}
interface TWord {
  text?: string;
  confidence?: number;
  bbox?: TBbox;
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

/**
 * Flatten per-word {text, bbox} pairs from a tesseract HOCR result. Empty if
 * the data did not include the `blocks: true` output flag. Used by column
 * reorder to detect layout and emit reading-order text.
 */
const collectWordBoxes = (data: unknown): OcrWordBox[] => {
  const d = data as TData | null;
  const out: OcrWordBox[] = [];
  if (!d) return out;
  for (const b of d.blocks ?? []) {
    for (const p of b.paragraphs ?? []) {
      for (const l of p.lines ?? []) {
        for (const w of l.words ?? []) {
          const t = (w.text ?? '').trim();
          if (!t || !w.bbox) continue;
          const { x0, y0, x1, y1 } = w.bbox;
          if (
            typeof x0 !== 'number' ||
            typeof y0 !== 'number' ||
            typeof x1 !== 'number' ||
            typeof y1 !== 'number'
          )
            continue;
          out.push({ text: t, x0, y0, x1, y1 });
        }
      }
    }
  }
  return out;
};

type RecognizeResult = Awaited<ReturnType<TesseractWorker['recognize']>>;
/** Executor that performs the actual tesseract recognise call. Lets the page
 *  OCR run on the single worker (default) OR a pooled scheduler worker — the
 *  recognise ARGUMENTS are identical either way, so the result is identical. */
type RecognizeExec = (bytes: Buffer, needHocr: boolean) => Promise<RecognizeResult>;

/** Pool variant: dispatch the SAME recognise call to the scheduler. */
const schedulerRecognizer =
  (sched: Scheduler): RecognizeExec =>
  (bytes, needHocr) =>
    (needHocr
      ? sched.addJob('recognize', bytes, {}, { blocks: true })
      : sched.addJob('recognize', bytes)) as Promise<RecognizeResult>;

const runOcr = async (
  bytes: Buffer,
  opts: { withWords?: boolean; withBoxes?: boolean } | boolean = false,
  recognize?: RecognizeExec,
): Promise<{
  text: string;
  confidence: number;
  wordConfidences: number[];
  wordBoxes: OcrWordBox[];
}> => {
  // Back-compat: accept the old boolean signature (withWords true/false).
  const o = typeof opts === 'boolean' ? { withWords: opts } : opts;
  const wantWords = o.withWords === true;
  const wantBoxes = o.withBoxes === true;
  const needHocr = wantWords || wantBoxes;
  const t0 = Date.now();
  // The HOCR path (blocks: true) gives us per-word bboxes (needed for column
  // reorder) AND per-word confidences (needed for handwriting routing). The
  // plain path stays byte-identical for callers that don't need either.
  // `recognize` (the pool executor) issues the SAME call on a pooled worker;
  // when omitted we use the single-worker singleton exactly as before.
  const { data } = recognize
    ? await recognize(bytes, needHocr)
    : await (async () => {
        const t = await getTesseract();
        return needHocr ? t.recognize(bytes, {}, { blocks: true }) : t.recognize(bytes);
      })();
  // eslint-disable-next-line no-console
  console.log(
    `[ocr-engine] tesseract done in ${Date.now() - t0}ms, ${data.text.length} chars, confidence=${Math.round(data.confidence)}%`,
  );
  return {
    text: data.text,
    confidence: data.confidence / 100,
    wordConfidences: wantWords ? collectWordConfidences(data) : [],
    wordBoxes: wantBoxes ? collectWordBoxes(data) : [],
  };
};

/**
 * Run `task(i)` for i in [0,count) with at most `limit` concurrent executions
 * (lanes pull the next index as they finish). limit=1 → fully serial. This is
 * the bounded dispatch for the OCR worker pool — pages are never all OCR'd at
 * once; concurrency is capped at OCR_PARALLEL_PAGES.
 */
const runBounded = async (
  count: number,
  limit: number,
  task: (i: number) => Promise<void>,
): Promise<void> => {
  const lanes = Math.max(1, Math.min(limit, count));
  let next = 0;
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (let i = next++; i < count; i = next++) await task(i);
    }),
  );
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

export interface OcrPageResult {
  pageNumber: number;
  text: string;
  confidence: number;
  wordConfidences: number[];
  /** Detected layout for the page (when reorder was applied). */
  layout: ReorderLayout;
  splitX: number | null;
  layoutConfidence: number;
  /** Priority-1 fix (A3): per-column reading-order texts. Always ≥1 entry.
   *  SINGLE/UNKNOWN: one entry (= text). TWO_COLUMN: two entries (left,right).
   *  parseDrafts runs ONCE PER COLUMN so column-A words can never end up
   *  between column-B words. */
  columns: string[];
}

interface OcrPdfResult {
  pages: OcrPageResult[];
  /** Concatenated text from ALL pages (kept for signalRaw / handwriting routing). */
  combinedText: string;
  /** Average confidence across pages. */
  confidence: number;
  pageCount: number;
  /** Flat per-word confidences across all pages (handwriting routing only). */
  wordConfidences: number[];
  /** Screenshot-first: one VISUAL draft per detected question (cropped image +
   *  page + coordinates + best-effort option count). Present only when ocrPdf
   *  was called with { screenshotFirst, putObject, figureKeyPrefix }. */
  visualDrafts?: OcrEngineDraft[];
}

const ocrPdf = async (
  bytes: Buffer,
  opts: {
    withWords?: boolean;
    reorderColumns?: boolean;
    onPageComplete?: (processed: number, total: number) => Promise<void> | void;
    /** Screenshot-first: crop one VISUAL draft per detected question. */
    screenshotFirst?: boolean;
    putObject?: (key: string, body: Buffer, contentType: string) => Promise<void>;
    figureKeyPrefix?: string;
  } = {},
): Promise<OcrPdfResult> => {
  const t0 = Date.now();
  // Reorder defaults ON — this is the correctness fix for 2-column papers.
  // Callers can opt out via { reorderColumns: false } to recover byte-identical
  // pre-Slice-2 behaviour for diagnosis if a paper regresses.
  const reorderColumns = opts.reorderColumns !== false;
  const withWords = opts.withWords === true;
  const screenshotFirst =
    opts.screenshotFirst === true && !!opts.putObject && !!opts.figureKeyPrefix;
  // Screenshot-first segmentation needs per-word boxes too.
  const withBoxes = reorderColumns || screenshotFirst;
  const pdf = await getPdfToImg();
  const doc = await pdf(bytes, { scale: 2 });
  const totalPages = doc.length;

  const pages: OcrPageResult[] = [];
  let confSum = 0;
  let pageCount = 0;
  const wordConfidences: number[] = [];
  const visualDrafts: OcrEngineDraft[] = [];
  const pageTraces: import('./visual-segment').PageMarkerTrace[] = [];
  // Carries a question that ran to the bottom of one page so its tail on the next
  // page can be stitched into the same crop (one question = one crop across pages).
  let segCarry: import('./visual-segment').SegmentCarry | null = null;
  try {
    // Watermark-removal stage (additive, before OCR). PASS 1: render all pages
    // and build a cross-page flat field that isolates a repeated watermark/logo/
    // stamp (content varies per page and washes out; the watermark persists).
    // PASS 2 (the loop below) divides each page by it, removing DARK or light
    // watermarks while protecting question content, then OCRs + crops the clean
    // page. The OCR engine and segmenter are unchanged.
    // Per-stage timing so a timeout can be pinned to the exact stage. memMB =
    // resident set size; logged before/after the (suspect) flat-field build.
    const ms = (n: number): string => `${(n / 1000).toFixed(1)}s`;
    const memMB = (): number => Math.round(process.memoryUsage().rss / 1024 / 1024);
    let tClean = 0;
    let tOcr = 0;
    let tSeg = 0;

    const { cleanPageImage, buildFlatField, buildWatermarkMask } =
      await import('./watermark-clean');
    const renderT0 = Date.now();
    const pageBuffers: Buffer[] = [];
    for await (const p of doc) pageBuffers.push(p);
    const m = pageBuffers.length ? await sharp(pageBuffers[0]).metadata() : { width: 0, height: 0 };
    // eslint-disable-next-line no-console
    console.log(
      `[OCR] Render PDF: ${ms(Date.now() - renderT0)} · pages=${pageBuffers.length} · ` +
        `resolution=${m.width ?? 0}x${m.height ?? 0} · mem=${memMB()}MB`,
    );

    const flatT0 = Date.now();
    // eslint-disable-next-line no-console
    console.log(`[OCR] Build Flat Field: starting · mem(before)=${memMB()}MB`);
    const flatField = await buildFlatField(pageBuffers);
    // eslint-disable-next-line no-console
    console.log(
      `[OCR] Build Flat Field: ${ms(Date.now() - flatT0)} · ` +
        `${flatField ? `field=${flatField.width}x${flatField.height}` : 'skipped (<3 pages / disabled)'} · ` +
        `mem(after)=${memMB()}MB`,
    );

    // DISPLAY-ONLY: large-watermark mask (big logos / diagonal banners / central
    // stamps) from the flat field. Gates the crop cleanup so only LARGE persistent
    // watermark blobs are removal candidates; thin lines, small labels and page
    // codes can never be whitened. Pure CPU, computed once; null when no flat field.
    const watermarkMask = buildWatermarkMask(flatField);
    // eslint-disable-next-line no-console
    console.log(
      `[OCR] Build Watermark Mask: ${watermarkMask ? `mask=${watermarkMask.width}x${watermarkMask.height}` : 'skipped (no flat field)'}`,
    );

    // ── Per-page OCR scheduling (OCR_PARALLEL_PAGES) ──────────────────────────
    // ORCHESTRATION ONLY. clean+OCR are per-page independent + deterministic, so
    // they may run on a bounded worker pool. The segmentation + draft-generation
    // tail (segmentVisualDrafts with its cross-page `segCarry`, column reorder,
    // pages[] accumulation, confSum, onPageComplete) ALWAYS runs SERIALLY in page
    // order in `finalizePage`, byte-identical to today. See the ORDERING
    // GUARANTEE in extractDrafts. Default 1 → the exact current serial path.
    const parallelPages = Math.max(1, Math.min(16, Number(process.env.OCR_PARALLEL_PAGES) || 1));

    // The serial per-page tail. Shared by the serial and pooled paths so the
    // unchanged pipeline runs through ONE code path; only WHO ran clean+OCR
    // differs. Mutates the outer accumulators in page order (never concurrently).
    const finalizePage = async (
      pageNumber: number,
      pageImage: Buffer,
      rawPageImage: Buffer,
      rawText: string,
      confidence: number,
      pageWords: number[],
      wordBoxes: OcrWordBox[],
    ): Promise<void> => {
      // Screenshot-first: detect each question's band on this page, crop it, and
      // emit one VISUAL draft per question.
      if (screenshotFirst) {
        const segT0 = Date.now();
        try {
          const { segmentVisualDrafts } = await import('./visual-segment');
          const {
            drafts: vd,
            carryOut,
            trace,
          } = await segmentVisualDrafts(pageImage, wordBoxes, pageNumber, {
            putObject: opts.putObject!,
            figureKeyPrefix: opts.figureKeyPrefix!,
            positionOffset: visualDrafts.length,
            carryIn: segCarry,
            // DISPLAY-ONLY: hand the cross-page flat field to the crop step so the
            // stored snapshot has its watermark suppressed. Pixels only — no
            // effect on OCR/segmentation (already done) or any draft field.
            displayFlat: flatField,
            // DISPLAY-ONLY: large-watermark mask gate — a crop pixel may be whitened
            // only if it sits inside a large persistent watermark blob (thin lines /
            // small labels / page codes are kept regardless of the per-pixel rules).
            displayMask: watermarkMask,
            // DISPLAY-ONLY: crop the SHOWN image from the RAW page so the pre-OCR
            // flat-field division can't brighten/erase dark content in the crop.
            // OCR still ran on the cleaned `pageImage` above — unchanged.
            displaySource: rawPageImage,
          });
          visualDrafts.push(...vd);
          pageTraces.push(trace);
          segCarry = carryOut;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[ocr-engine] screenshot-first segmentation failed on page ${pageNumber} (non-fatal): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        tSeg += Date.now() - segT0;
      }
      confSum += confidence;
      if (withWords && pageWords.length > 0) wordConfidences.push(...pageWords);

      // Column reorder when HOCR boxes are present; otherwise keep tesseract's
      // raw text (single-column pages already read correctly that way).
      let pageText = rawText.trim();
      let layout: ReorderLayout = 'UNKNOWN';
      let splitX: number | null = null;
      let layoutConfidence = 0;
      let columns: string[] = [pageText];
      if (reorderColumns && wordBoxes.length > 0) {
        const rr = reorderByColumns(wordBoxes);
        pageText = rr.text;
        layout = rr.layout;
        splitX = rr.splitX;
        layoutConfidence = rr.confidence;
        columns = rr.columns;
      }
      pages.push({
        pageNumber,
        text: pageText,
        confidence,
        wordConfidences: pageWords,
        layout,
        splitX,
        layoutConfidence,
        columns,
      });
      // eslint-disable-next-line no-console
      console.log(
        `[ocr-engine] pdf page ${pageNumber}: ${rawText.length} chars${
          reorderColumns && wordBoxes.length > 0
            ? ` layout=${layout}${splitX !== null ? `@x=${splitX.toFixed(0)}` : ''}`
            : ''
        }`,
      );
      // Phase 2 — live progress: fire-and-forget. Caller's repo write must not
      // block the OCR loop; if it throws we swallow + log (the OCR work itself
      // already succeeded and we don't want a progress-row failure to undo it).
      if (opts.onPageComplete) {
        try {
          await opts.onPageComplete(pageNumber, totalPages);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[ocr-engine] onPageComplete handler failed (non-fatal): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    };

    if (parallelPages <= 1) {
      // SERIAL (default, OCR_PARALLEL_PAGES=1) — the exact current behaviour.
      let pageNumber = 0;
      for (const rawPageImage of pageBuffers) {
        pageNumber += 1;
        const cleanT0 = Date.now();
        const pageImage = await cleanPageImage(rawPageImage, flatField);
        tClean += Date.now() - cleanT0;
        const ocrT0 = Date.now();
        const { text, confidence, wordConfidences: pageWords, wordBoxes } = await runOcr(pageImage, {
          withWords,
          withBoxes,
        });
        tOcr += Date.now() - ocrT0;
        await finalizePage(pageNumber, pageImage, rawPageImage, text, confidence, pageWords, wordBoxes);
      }
    } else {
      // POOLED — a bounded worker pool runs clean+OCR (per-page independent);
      // results are collected into a page-indexed array; THEN the segmentation /
      // draft-generation tail runs serially in page order (unchanged). Pages are
      // never all OCR'd at once — concurrency is capped at OCR_PARALLEL_PAGES.
      const sched = await getScheduler(parallelPages);
      const recognize = schedulerRecognizer(sched);
      interface PageOcr {
        pageImage: Buffer;
        rawPageImage: Buffer;
        text: string;
        confidence: number;
        pageWords: number[];
        wordBoxes: OcrWordBox[];
      }
      const perPage: Array<PageOcr | undefined> = new Array(pageBuffers.length);
      // eslint-disable-next-line no-console
      console.log(`[ocr-engine] OCR_PARALLEL_PAGES=${parallelPages} — pooled page OCR`);
      await runBounded(pageBuffers.length, parallelPages, async (idx) => {
        const rawPageImage = pageBuffers[idx];
        const cleanT0 = Date.now();
        const pageImage = await cleanPageImage(rawPageImage, flatField);
        tClean += Date.now() - cleanT0;
        const ocrT0 = Date.now();
        const { text, confidence, wordConfidences: pageWords, wordBoxes } = await runOcr(
          pageImage,
          { withWords, withBoxes },
          recognize,
        );
        tOcr += Date.now() - ocrT0;
        perPage[idx] = { pageImage, rawPageImage, text, confidence, pageWords, wordBoxes };
      });
      // Serial, page-ascending segmentation/draft tail (unchanged). Release each
      // page's images right after use to keep peak memory bounded.
      for (let idx = 0; idx < perPage.length; idx += 1) {
        const r = perPage[idx]!;
        await finalizePage(idx + 1, r.pageImage, r.rawPageImage, r.text, r.confidence, r.pageWords, r.wordBoxes);
        perPage[idx] = undefined;
      }
    }
    pageCount = pages.length;

    // Per-stage totals — pinpoints which stage dominates / exceeds the timeout.
    // (In pooled mode tClean/tOcr are summed CPU time across workers, so they may
    // exceed wall-clock; that is expected.)
    // eslint-disable-next-line no-console
    console.log(
      `[OCR] Clean Pages: ${ms(tClean)} · OCR Extraction: ${ms(tOcr)} · ` +
        `Segmentation: ${ms(tSeg)} · mem=${memMB()}MB`,
    );
  } finally {
    await doc.destroy().catch(() => {
      /* swallow shutdown errors */
    });
  }

  const avgConf = pageCount > 0 ? confSum / pageCount : 0;
  const combinedText = pages.map((p) => p.text).join('\n\n');
  // eslint-disable-next-line no-console
  console.log(
    `[ocr-engine] pdf done: ${pageCount} page(s), ${combinedText.length} chars total, avgConfidence=${Math.round(avgConf * 100)}%, ${Date.now() - t0}ms`,
  );
  // Segmentation quality report — never silently accept missing questions. Logged
  // so coverage gaps are visible before teacher review. OCR_EXPECTED_QUESTIONS
  // (e.g. 180 for RE NEET PST 3) pins the target; otherwise it's inferred.
  if (visualDrafts.length > 0) {
    try {
      const { buildQualityReport } = await import('./visual-segment');
      const expected = Number(process.env.OCR_EXPECTED_QUESTIONS) || null;
      // Layout awareness: report the per-page column distribution so single- vs
      // multi-column behaviour is visible (segmentation reads column-by-column).
      const layoutDist = new Map<number, number>();
      for (const t of pageTraces)
        layoutDist.set(t.columnCount, (layoutDist.get(t.columnCount) ?? 0) + 1);
      const layoutStr = [...layoutDist.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([cols, n]) => `${cols}col×${n}p`)
        .join(' ');
      // eslint-disable-next-line no-console
      console.log(`[ocr-engine] layout: ${layoutStr || 'n/a'}`);
      const report = buildQualityReport(visualDrafts, expected, pageTraces);
      // eslint-disable-next-line no-console
      console.log(
        `[ocr-engine] segmentation: detected=${report.detected} expected=${report.expected ?? '?'} ` +
          `coverage=${report.coveragePct}% missing=${report.missingNumbers.length} ` +
          `duplicates=${report.duplicateNumbers.length} multiQuestionCrops=${report.multiQuestionCrops.length} ` +
          `invalidCrops=${report.invalidCrops} numbersLost=${report.missingQuestionNumberPositions.length} ` +
          `needsReview=${report.needsManualReview}`,
      );
      if (
        report.missingNumbers.length ||
        report.duplicateNumbers.length ||
        report.multiQuestionCrops.length
      ) {
        // eslint-disable-next-line no-console
        console.warn('[ocr-engine] segmentation gaps', {
          missingNumbers: report.missingNumbers.slice(0, 50),
          duplicateNumbers: report.duplicateNumbers,
          multiQuestionCrops: report.multiQuestionCrops.slice(0, 20),
        });
        // Per-missing diagnostic — Expected / Previous / Next / Page / Column —
        // so each gap's cause (page break, watermark, table, tiny gap, failed
        // read) is obvious without re-opening the PDF.
        for (const d of report.missing.slice(0, 50)) {
          // Question=N · OCR detected · Marker created · Boundary created · Draft
          // generated (+ where it disappeared). Boundary/draft are NO for a miss
          // by definition; mergedIntoDraft shows the neighbour that swallowed it.
          // eslint-disable-next-line no-console
          console.warn(
            `[ocr-engine]   Question=${d.expected} OCR=${d.ocrDetected ? 'YES' : 'NO'} ` +
              `Marker=${d.markerDetected ? 'YES' : 'NO'} Boundary=NO Draft=NO ` +
              `stage=${d.stage} removedInSequence=${d.removedInSequence ? 'YES' : 'NO'} ` +
              `mergedIntoDraft=${d.mergedIntoDraft ?? '-'} previous=${d.previous ?? '?'} next=${d.next ?? '?'} ` +
              `page=${d.page ?? '?'} column=${d.column ?? '?'}`,
          );
        }
      }
    } catch {
      /* report is advisory — never break extraction */
    }
  }
  return {
    pages,
    combinedText,
    confidence: avgConf,
    pageCount,
    wordConfidences,
    visualDrafts: visualDrafts.length > 0 ? visualDrafts : undefined,
  };
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
  opts: {
    withWords?: boolean;
    storageKey?: string;
    /** Server-side direct upload for figure crops (Slice 2.3). */
    putObject?: (key: string, body: Buffer, contentType: string) => Promise<void>;
    /** Key prefix for uploaded figure crops, e.g. `tenants/{T}/ocr-figures`. */
    figureKeyPrefix?: string;
    /**
     * Phase 2 — live progress hook. Invoked after each page finishes OCR
     * (tesseract path: once per for-loop iteration; paddle path: once at
     * dispatch completion with processed=total). Throws inside the callback
     * MUST NOT break extraction — wrap your handler in try/catch upstream.
     */
    onPageComplete?: (processed: number, total: number) => Promise<void> | void;
  } = {},
): Promise<OcrEngineResult> => {
  const withWords = opts.withWords === true;
  // Screenshot-first (default) applies to BOTH PDFs and single-image uploads:
  // crop one VISUAL draft per detected question, never reconstruct text. Opt out
  // with OCR_TEXT_RECONSTRUCTION=true. Requires the storage upload hook.
  const screenshotFirst =
    process.env.OCR_TEXT_RECONSTRUCTION !== 'true' && !!opts.putObject && !!opts.figureKeyPrefix;

  if (mime === 'application/pdf') {
    const engineT0 = Date.now();
    // Slice 2.2 — opt-in: route PDF OCR to the Python PaddleOCR service for
    // dramatically better recognition of circled-digit options + dense layouts.
    // Any failure (no URL, circuit open, timeout, non-2xx, malformed body) →
    // dispatcher returns null → we fall through to the tesseract path. The
    // downstream pipeline (column reorder, page classification, parseDrafts)
    // is single-chokepoint, so the engine swap is transparent.
    const useViaPaddle =
      process.env.PRINTED_OCR_VIA_PADDLE === 'true' &&
      !!opts.storageKey &&
      !!process.env.PRINTED_OCR_URL;
    let ocrPdfResult: Awaited<ReturnType<typeof ocrPdf>> | null = null;
    let providerLabel = `tesseract:pdf`;
    let figuresByPage: Map<number, PageFigureRef[]> | null = null;
    // Phase B — typed regions from the Paddle PP-Structure pass (empty when
    // the Python flag is off; consumed below by the region-aware attacher).
    let paddleRegions: import('./paddle-printed-http').OcrRegion[] = [];
    if (useViaPaddle) {
      // eslint-disable-next-line no-console
      console.log(`[ocr-timing] paddle_started +0ms`);
      const paddleT0 = Date.now();
      const paddle = await ocrPdfViaPaddle({
        serviceUrl: process.env.PRINTED_OCR_URL ?? null,
        storageKey: opts.storageKey!,
        mime,
        timeoutMs: Number(process.env.PRINTED_OCR_TIMEOUT_MS) || 180_000,
        putObject: opts.putObject,
        figureKeyPrefix: opts.figureKeyPrefix,
      });
      // eslint-disable-next-line no-console
      console.log(
        `[ocr-timing] paddle_finished +${Date.now() - engineT0}ms dur=${Date.now() - paddleT0}ms ok=${paddle !== null} pages=${paddle?.pageCount ?? 0}`,
      );
      if (paddle) {
        ocrPdfResult = paddle;
        providerLabel = paddle.providerUsed;
        figuresByPage = paddle.figuresByPage;
        paddleRegions = paddle.regions;
        // eslint-disable-next-line no-console
        console.log(`[ocr-engine] printed OCR via Paddle service (${paddle.pageCount}p)`);
        // Phase 2 — Paddle returns all pages at once; fire a single completion
        // ping so the UI can transition from OCR_PROCESSING → EXTRACTING.
        if (opts.onPageComplete) {
          try {
            await opts.onPageComplete(paddle.pageCount, paddle.pageCount);
          } catch {
            /* non-fatal */
          }
        }
      } else {
        // eslint-disable-next-line no-console
        console.warn('[ocr-engine] paddle service unavailable; falling back to tesseract');
      }
    }
    if (!ocrPdfResult) {
      // eslint-disable-next-line no-console
      console.log(`[ocr-timing] tesseract_started +${Date.now() - engineT0}ms`);
      const tessT0 = Date.now();
      ocrPdfResult = await ocrPdf(bytes, {
        withWords,
        reorderColumns: true,
        onPageComplete: opts.onPageComplete,
        // Screenshot-first (default) — auto-segment + crop one VISUAL draft per
        // question. Opt out with OCR_TEXT_RECONSTRUCTION=true. Requires the
        // storage upload hook (always present on the job-runner path).
        screenshotFirst,
        putObject: opts.putObject,
        figureKeyPrefix: opts.figureKeyPrefix,
      });
      // eslint-disable-next-line no-console
      console.log(
        `[ocr-timing] tesseract_finished +${Date.now() - engineT0}ms dur=${Date.now() - tessT0}ms pages=${ocrPdfResult.pageCount}`,
      );
    }
    const { pages, combinedText, confidence, pageCount, wordConfidences } = ocrPdfResult;

    // Classify every page so non-question pages (instructions / answer keys /
    // OMR) are filtered out BEFORE parseDrafts. Pages classified as QUESTION or
    // UNKNOWN-with-content enter extraction; the rest are skipped but recorded
    // in pageMetadata for the reviewer's visibility.
    const classifications = classifyAllPages(pages.map((p) => p.text));

    // ─── ORDERING GUARANTEE ──────────────────────────────────────────────
    // Drafts are accumulated in STRICT page-ascending order by iterating the
    // `pages` array sequentially (i = 0 .. n-1). Each page's drafts are produced
    // by parseDrafts in document reading order, with positionOffset = current
    // drafts.length, so global positions are sequential and contiguous. The
    // order is preserved by:
    //   (a) ocrPdf returning pages in pdf-to-img iteration order (which is
    //       page-ascending), and
    //   (b) this loop being a serial for-loop (NOT Promise.all) — drafts are
    //       only appended once a page completes parsing.
    // When Slice 2 introduces per-page concurrency, the same guarantee MUST be
    // preserved by collecting per-page results into an indexed array and
    // flattening in page order AFTER all pages complete — never by appending
    // in completion order. See `parseDrafts` for the within-page ordering.
    // ─────────────────────────────────────────────────────────────────────
    const draftsT0 = Date.now();
    // Screenshot-first: ocrPdf already produced one cropped VISUAL draft per
    // detected question. Use them directly and SKIP text reconstruction +
    // figure attachment entirely (the image is the source of truth).
    const usingVisual = (ocrPdfResult.visualDrafts?.length ?? 0) > 0;
    const drafts: OcrEngineDraft[] = usingVisual ? [...ocrPdfResult.visualDrafts!] : [];
    if (usingVisual) {
      // eslint-disable-next-line no-console
      console.log(
        `[ocr-engine] screenshot-first: ${drafts.length} visual draft(s) from ${pages.length} page(s)`,
      );
    }
    for (let i = 0; !usingVisual && i < pages.length; i += 1) {
      const cls = classifications[i];
      const page = pages[i];
      if (!isExtractableQuestionPage(cls)) {
        // eslint-disable-next-line no-console
        console.log(
          `[ocr-engine] page ${cls.pageNum} skipped (type=${cls.type}, conf=${cls.confidence.toFixed(2)}, words=${cls.wordCount})`,
        );
        continue;
      }
      // Priority-1 fix (A3): run parseDrafts ONCE PER COLUMN so two-column
      // pages can never produce interleaved word streams. Left-column drafts
      // come out first (lower global positions), right-column drafts after.
      // SINGLE/UNKNOWN pages produce one column == page.text, so behavior is
      // identical to pre-fix for non-multi-column papers.
      const cols = page.columns && page.columns.length > 0 ? page.columns : [page.text];
      for (let c = 0; c < cols.length; c += 1) {
        const colText = cols[c];
        if (!colText || colText.trim().length === 0) continue;
        const colDrafts = parseDrafts(colText, page.confidence, {
          pageNumber: page.pageNumber,
          positionOffset: drafts.length,
        });
        drafts.push(...colDrafts);
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `[ocr-timing] drafts_parsed +${Date.now() - engineT0}ms dur=${Date.now() - draftsT0}ms count=${drafts.length}`,
    );

    // Per-upload classification audit — one line in the engine log makes OCR
    // debugging significantly easier. Matches the user's requested format.
    // eslint-disable-next-line no-console
    console.log(
      `[ocr-engine] page summary: ${summarizeClassifications(classifications)} → ${drafts.length} draft(s) extracted`,
    );

    // Phase B / Slice 2.3 — associate per-page figures (and Phase B tables)
    // with drafts.
    //
    // When PP-Structure regions are present AND the engine is invoked with
    // OCR_USE_REGIONS=true, the spatial attacher takes over: it anchors each
    // draft to the Y-range of the PP-Structure TEXT/TITLE regions it owns,
    // then picks the draft with maximum Y-overlap for each figure/table.
    // Tables also carry their HTML through to draft.tableHtml / draft.tables.
    //
    // Otherwise we fall back to the Slice 2.3 proportional-Y stripe heuristic
    // (divide page into N stripes for N drafts, bucket each figure into the
    // stripe its centerY falls in). Same behavior as before Phase B.
    const figuresT0 = Date.now();
    const useRegionAttach = process.env.OCR_USE_REGIONS === 'true' && paddleRegions.length > 0;
    if (useRegionAttach) {
      const { attachFiguresByRegions } = await import('./region-attach');
      const r = attachFiguresByRegions({
        drafts,
        figuresByPage: figuresByPage ?? new Map(),
        regions: paddleRegions,
      });
      if (r.figuresAttached > 0 || r.tablesAttached > 0 || r.snapshotsAttached > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[ocr-engine] regions: attached ${r.figuresAttached} figure(s) + ${r.tablesAttached} table(s) + ${r.snapshotsAttached} snapshot(s) to drafts`,
        );
      }
      // eslint-disable-next-line no-console
      console.log(
        `[ocr-timing] figures_attached +${Date.now() - engineT0}ms dur=${Date.now() - figuresT0}ms attached=${r.figuresAttached} tables=${r.tablesAttached} via=regions`,
      );
    } else if (figuresByPage && figuresByPage.size > 0) {
      let totalAttached = 0;
      // Group drafts by source page (preserve sequence within page).
      const draftsByPage = new Map<number, OcrEngineDraft[]>();
      for (const d of drafts) {
        if (d.sourcePageNumber === undefined) continue;
        const arr = draftsByPage.get(d.sourcePageNumber) ?? [];
        arr.push(d);
        draftsByPage.set(d.sourcePageNumber, arr);
      }
      for (const [pageNum, pageFigs] of figuresByPage) {
        const pageDrafts = draftsByPage.get(pageNum);
        if (!pageDrafts || pageDrafts.length === 0) continue;
        const N = pageDrafts.length;
        for (const fig of pageFigs) {
          const norm =
            fig.pageHeight > 0 ? Math.min(1, Math.max(0, fig.centerY / fig.pageHeight)) : 0.5;
          const idx = Math.min(N - 1, Math.floor(norm * N));
          const target = pageDrafts[idx];
          if (!target.figures) target.figures = [];
          target.figures.push({
            storageKey: fig.storageKey,
            kind: fig.kind,
            boundingBox: fig.boundingBox,
            caption: fig.caption,
          });
          totalAttached += 1;
        }
      }
      if (totalAttached > 0) {
        // eslint-disable-next-line no-console
        console.log(`[ocr-engine] attached ${totalAttached} figure(s) to drafts`);
      }
      // eslint-disable-next-line no-console
      console.log(
        `[ocr-timing] figures_attached +${Date.now() - engineT0}ms dur=${Date.now() - figuresT0}ms attached=${totalAttached}`,
      );
    }

    let sentinel = false;
    if (drafts.length === 0) {
      sentinel = true;
      drafts.push({
        position: 0,
        text:
          combinedText.slice(0, 2000).trim() || '(OCR produced no extractable text from this PDF)',
        detectedType: 'DESCRIPTIVE',
        confidence,
      });
    }
    const layoutMetadata: PageLayoutInfo[] = pages.map((p) => ({
      pageNumber: p.pageNumber,
      layout: p.layout,
      splitX: p.splitX,
      confidence: p.layoutConfidence,
    }));
    const result: OcrEngineResult = {
      providerUsed:
        providerLabel === 'tesseract:pdf' ? `tesseract:pdf(${pageCount}p)` : providerLabel,
      overallConfidence: confidence,
      drafts,
      pageMetadata: classifications,
      layoutMetadata,
    };
    if (withWords) result.signalRaw = { text: combinedText, pageCount, wordConfidences, sentinel };
    return result;
  }

  // Watermark-removal stage for single-image uploads — same additive cleanup the
  // PDF path uses, before OCR + segmentation.
  const { cleanPageImage } = await import('./watermark-clean');
  const imageBytes = await cleanPageImage(bytes);

  // Screenshot-first for single-image uploads (jpg/png): the uploaded image IS
  // the page — detect each question's band, crop it, and emit one VISUAL draft
  // per question. No text reconstruction, no parsed options.
  if (screenshotFirst) {
    const { wordBoxes } = await runOcr(imageBytes, { withBoxes: true });
    try {
      const { segmentVisualDrafts } = await import('./visual-segment');
      const { drafts: visual } = await segmentVisualDrafts(imageBytes, wordBoxes, 1, {
        putObject: opts.putObject!,
        figureKeyPrefix: opts.figureKeyPrefix!,
      });
      if (visual.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[ocr-engine] screenshot-first (image): ${visual.length} visual draft(s)`);
        return {
          providerUsed: 'tesseract:image(visual)',
          overallConfidence: 1,
          drafts: visual,
        };
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ocr-engine] screenshot-first image segmentation failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const { text, confidence, wordConfidences } = await runOcr(imageBytes, { withWords });
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
  const result: OcrEngineResult = {
    providerUsed: 'tesseract',
    overallConfidence: confidence,
    drafts,
  };
  if (withWords) result.signalRaw = { text, pageCount: 1, wordConfidences, sentinel };
  return result;
};
