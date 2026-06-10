import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { filterRepeatedWatermarks, type OcrWordBox } from './column-reorder';
import type { OcrEngineDraft } from './ocr-engine';

/**
 * Screenshot-first segmentation. Instead of reconstructing question TEXT (which
 * corrupts on formula/chemistry/graph/circuit content), we detect each question
 * region from OCR word boxes and crop it to a PNG — one Visual draft per
 * question. OCR text is kept as metadata only and is never rendered.
 *
 * Layout-aware: real papers have 1–4 COLUMNS. We first cluster question markers
 * by X-position into columns, then within each column split by Y at the next
 * question marker. A region is therefore (column x-range) × (question y-range),
 * so a multi-column page never merges Q1 + Q26 + … into one crop, and the next
 * question marker always terminates the current region.
 *
 * Coordinates are in the rendered page-image pixel space (pdf-to-img scale 2 /
 * the uploaded image), the SAME space as the page buffer, so crops are direct.
 */

// Option markers (for best-effort option counting): "(1)" "(a)" "A." "a)".
// NOT used to gate question starts — that is auto-detected per page (below).
const OPTION_MARKER_RE = /^(?:([A-Da-d])[.)]|\(([A-Da-d1-9])\))$/;

// Question-number markers at the START of a token. These are TOLERANT PREFIX
// matches (not full-token), because dense exam papers routinely glue the number
// to the question text with no space — "104.Select", "104)A" — and a strict
// "^\d+\.$" match would MISS those, silently merging two questions into one crop.
// A digit after the punctuation is rejected ONLY when it forms a pure decimal /
// time ("1.5", "12:30") — i.e. digits that are NOT immediately followed by a
// letter. This still catches a glued question whose first letter OCR mis-read as
// a digit, e.g. "108.0bserve" ("Observe" → "0bserve"), which the old `(?!\d)`
// guard wrongly rejected as the decimal "108.0".
// The terminator class is "." ":" AND ";" "," — OCR frequently mis-reads the
// period after a question number as a semicolon or comma (real cases: "43." → "43;",
// "44." → "44,"), which silently dropped/merged the question. The SAME decimal
// guard `(?!\d+(?![A-Za-z]))` keeps thousands/decimals out: "1,000"/"12:30"/"1.5"
// are still rejected (a digit-run after the mark that is not glued to a letter),
// while "43;", "44,", "44,which" are accepted. line-start + sequence validation
// remain the outer safeguards, so a stray in-text "44," cannot survive.
const NUM_DOT_RE = /^(\d{1,3})[.:;,](?!\d+(?![A-Za-z]))/; // "1." "104.Select" "108.0bserve" "43;" "44,"; rejects "1.5"/"12:30"/"1,000"
const NUM_PAREN_RE = /^(\d{1,3})\)(?!\d)/; // "1)" "104)Select"
const Q_PREFIX_RE = /^Q\.?\s?(\d{1,3})\b/i; // "Q1" "Q.1" "Q 1"
const QUESTION_WORD_RE = /^Question$/i; // "Question" (its number follows separately)
// Number glued straight onto text with NO punctuation: "150Match", "150Assertion".
// Restricted to 2–3 digits (value ≥ 10) so it can NEVER match a single-digit
// OPTION — options are "(1)".."(4)" / "a)" and never a bare ≥10 number.
const NUM_GLUED_RE = /^(\d{2,3})(?=[A-Za-z])/;

// A "question number" above this is implausible for any real exam — it is almost
// always an OCR mis-read of an IN-TEXT value (a temperature like "273", a year, a
// measurement) that happened to begin a line. Such a phantom marker spawns a bogus
// column/draft AND inflates the expected range in buildQualityReport (e.g. one "273"
// makes coverage compute against 1..273). Rejecting it at marker detection fixes
// both. Configurable; default 250 (no standard exam numbers a question this high).
const MAX_QUESTION_NUMBER = Number(process.env.OCR_MAX_QUESTION_NUMBER ?? 250);

// Strip leading OCR noise (a stray quote / pipe / stray punctuation tesseract
// sometimes prepends, e.g. `"103.Major`) so the `^`-anchored number regexes still
// match. Leading "(" is intentionally KEPT so option shapes "(1)" stay options.
const stripLeadNoise = (text: string): string => text.replace(/^["'`|.,;:_\-—\s]+/, '');

// An OPTION marker — paren-wrapped digit/letter, or a lettered option. These must
// NEVER be treated as a question start. (A digit-suffix "1)" is intentionally NOT
// here: it is ambiguous with a question number and is disambiguated by the page's
// question punctuation + the increasing-sequence rule instead.)
const OPTION_SHAPED_RE = /^(?:\((?:\d{1,2}|[A-Za-z])\)|[A-Za-z][.)])/; // "(1)" "(a)" "a)" "a."
// Does a token carry the page's QUESTION punctuation (so a low number like "4."
// is a real question, while a bare "4" or "(4)" is not)?
const hasQuestionPunct = (text: string, qPunct: ')' | '.'): boolean =>
  qPunct === '.' ? /^\d{1,3}[.:;,]/.test(text) : /^\d{1,3}\)/.test(text);
// Any shape that denotes a question number (used to protect numbers from the
// watermark filter).
const isQuestionNumberToken = (text: string): boolean => {
  const t = stripLeadNoise(text);
  return NUM_DOT_RE.test(t) || NUM_PAREN_RE.test(t) || Q_PREFIX_RE.test(t) || NUM_GLUED_RE.test(t);
};

export interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface Marker {
  x0: number;
  y0: number;
  /** Detected question number, when the marker carried one ("104." → 104). */
  num?: number;
}
export interface Column {
  left: number;
  right: number;
  markers: Marker[];
}

/** Median word height (px); falls back to 20 when unknown. */
export const medianHeight = (words: OcrWordBox[]): number => {
  const hs = words
    .map((w) => w.y1 - w.y0)
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  return hs.length ? hs[Math.floor(hs.length / 2)] : 20;
};

/**
 * True when `marker` actually STARTS a text line — it has clear horizontal space
 * to its left on its own line. This rejects a "5)" sitting mid-sentence, an
 * indented continuation, or a stray number inside option/instruction text.
 * Column-agnostic: a column GUTTER to the left counts as clear space, so a
 * marker at the 2nd/3rd/4th column's left margin still qualifies.
 */
const isLineStart = (marker: OcrWordBox, words: OcrWordBox[], medianH: number): boolean => {
  const yTol = medianH * 0.6;
  const cy = (marker.y0 + marker.y1) / 2;
  const clear = medianH * 2; // need ~2 line-heights of empty space to the left
  for (const w of words) {
    if (w === marker) continue;
    const wcy = (w.y0 + w.y1) / 2;
    if (Math.abs(wcy - cy) > yTol) continue; // different text line
    if (w.x1 <= marker.x0 && marker.x0 - w.x1 < clear) return false; // a word is just left
  }
  return true;
};

type PunctMarker = { num: number; punct: ')' | '.' | 'Q'; x0: number; y0: number };

/** Line-start tokens that look like a question number, keeping their punctuation
 *  family and value so we can tell questions from options statistically. */
const parseLineStartMarkers = (words: OcrWordBox[], medianH: number): PunctMarker[] => {
  const out: PunctMarker[] = [];
  for (const w of words) {
    if (!isLineStart(w, words, medianH)) continue;
    let m: RegExpExecArray | null;
    // Order matters: an option shape ("(1)", "a)") is never a question start, so
    // it is rejected before any numeric match can fire. The option check uses the
    // ORIGINAL text; numeric matches use the noise-stripped text so a prepended
    // stray char (`"103.Major`) doesn't hide the number.
    if (OPTION_SHAPED_RE.test(w.text)) continue;
    const t = stripLeadNoise(w.text);
    if ((m = NUM_DOT_RE.exec(t))) out.push({ num: +m[1], punct: '.', x0: w.x0, y0: w.y0 });
    else if ((m = NUM_PAREN_RE.exec(t))) out.push({ num: +m[1], punct: ')', x0: w.x0, y0: w.y0 });
    else if ((m = Q_PREFIX_RE.exec(t))) out.push({ num: +m[1], punct: 'Q', x0: w.x0, y0: w.y0 });
    else if (QUESTION_WORD_RE.test(t)) out.push({ num: NaN, punct: 'Q', x0: w.x0, y0: w.y0 });
    // Glued, punctuation-less ("150Match") — punct-agnostic, always a question.
    else if ((m = NUM_GLUED_RE.exec(t))) out.push({ num: +m[1], punct: 'Q', x0: w.x0, y0: w.y0 });
  }
  return out;
};

/**
 * Validated question-start markers. Auto-detects the paper's question-numbering
 * punctuation: a question number runs through MANY distinct values (1..N), while
 * an option number only repeats 1..4 — so we pick whichever of "N)" / "N." has
 * more DISTINCT values as the question marker, and treat the other as options.
 * "Q1"/"Question" prefixes always count as questions. Every candidate must also
 * genuinely start a line (clear space to its left), so mid-sentence "5)" and
 * indented tokens never open a region — across any number of columns.
 */
/** The question-numbering punctuation for this page: questions span many
 *  distinct values (1..N); options only repeat 1..4 — pick the family with more
 *  distinct values. */
export const detectQuestionPunct = (words: OcrWordBox[], medianH: number): ')' | '.' => {
  const parsed = parseLineStartMarkers(words, medianH);
  const stats = (p: ')' | '.'): { distinct: number; ratio: number; count: number } => {
    const nums = parsed.filter((m) => m.punct === p && !Number.isNaN(m.num)).map((m) => m.num);
    const distinct = new Set(nums).size;
    return {
      distinct,
      count: nums.length,
      ratio: distinct ? nums.length / distinct : Number.POSITIVE_INFINITY,
    };
  };
  const paren = stats(')');
  const dot = stats('.');
  if (paren.count === 0) return dot.count === 0 ? ')' : '.';
  if (dot.count === 0) return ')';
  // Question numbers appear about ONCE each (ratio≈1); OPTION numbers repeat the
  // same 1..4 in every question (ratio≫1). So prefer the family that repeats
  // LESS — this correctly picks ")" even when "." option-numbers outnumber it.
  // Only a clear ratio gap decides; a near-tie falls back to "more distinct".
  if (Math.abs(paren.ratio - dot.ratio) > 0.5) return paren.ratio < dot.ratio ? ')' : '.';
  return paren.distinct >= dot.distinct ? ')' : '.';
};

export const findQuestionMarkers = (
  words: OcrWordBox[],
  medianH: number,
  qPunct: ')' | '.' = detectQuestionPunct(words, medianH),
  // Out-of-range ceiling. Default rejects phantom numbers (an in-text "273"/"541"
  // misread as a marker). The recovery passes pass Infinity so they can still SEE a
  // correctable spike (e.g. "270." → "170.") BEFORE it is dropped; the spike is
  // rewritten in-place, then the default-ceiling call at segmentation keeps 170.
  maxNum: number = MAX_QUESTION_NUMBER,
): Marker[] =>
  parseLineStartMarkers(words, medianH)
    .filter((m) => m.punct === qPunct || m.punct === 'Q')
    // Drop out-of-range phantom numbers — but KEEP NaN "Question"-word markers.
    .filter((m) => Number.isNaN(m.num) || m.num <= maxNum)
    .map((m) => ({ x0: m.x0, y0: m.y0, num: m.num }))
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

/**
 * Per-column question-number sequence validation — the heart of question-START
 * driven segmentation. Real question numbers increase monotonically down a
 * column (101, 102, 103, …); option numbers (1-4) and stray numerics do NOT, so
 * we keep only markers whose number is strictly greater than the last kept one.
 * This excludes options WITHOUT depending on the whitespace gap between questions
 * (which is tiny in dense papers). Markers with no number (a bare "Question"
 * word) are always kept. Columns are validated independently, preserving the
 * left-column-then-right-column reading order.
 */
export const validateMarkerSequence = (columns: Column[]): Column[] =>
  columns.map((col) => {
    const sorted = [...col.markers].sort((a, b) => a.y0 - b.y0);
    const kept: Marker[] = [];
    let last = Number.NEGATIVE_INFINITY;
    for (const m of sorted) {
      if (m.num === undefined || Number.isNaN(m.num)) {
        kept.push(m);
        continue;
      }
      if (m.num > last) {
        kept.push(m);
        last = m.num;
      }
    }
    return { ...col, markers: kept };
  });

/* ─────────────────────────────────────────── Block content classification */

export type QuestionClass =
  | 'MCQ'
  | 'TRUE_FALSE'
  | 'ASSERTION_REASON'
  | 'MATCH_THE_FOLLOWING'
  | 'FILL_IN_THE_BLANK'
  | 'DESCRIPTIVE'
  | 'DIAGRAM_BASED'
  | 'UNKNOWN';

const hasTrueFalse = (words: OcrWordBox[]): boolean =>
  words.some((w) => /^true[.)]?$/i.test(w.text)) && words.some((w) => /^false[.)]?$/i.test(w.text));

/** Distinct OPTION labels in a block. Options are letter/paren markers always,
 *  plus numeric markers with the NON-question punctuation (so "1." is an option
 *  when questions use ")" and vice-versa). The question marker is excluded. */
const optionLabels = (words: OcrWordBox[], qPunct: ')' | '.'): Set<string> => {
  const labels = new Set<string>();
  for (const w of words) {
    let m: RegExpExecArray | null;
    if ((m = /^([A-Da-d])[.)]$/.exec(w.text))) labels.add('L' + m[1].toLowerCase());
    else if ((m = /^\(([A-Da-d1-9])\)$/.exec(w.text))) labels.add('P' + m[1].toLowerCase());
    else if (qPunct === ')' && (m = /^(\d{1,3})\.$/.exec(w.text))) labels.add('N' + m[1]);
    else if (qPunct === '.' && (m = /^(\d{1,3})\)$/.exec(w.text))) labels.add('N' + m[1]);
  }
  return labels;
};

/** A token that is the question number itself (so it never counts as stem text). */
const QNUM_TOKEN_RE = /^(?:Q\.?\d{1,3}|Question|\d{1,3}[.)])$/i;

/** Is this token an option/answer label (letter, paren, the non-question numeric
 *  family, or True/False)? Such tokens are NOT stem content. */
const isAnswerLabelToken = (text: string, qPunct: ')' | '.'): boolean =>
  /^([A-Da-d])[.)]$/.test(text) ||
  /^\(([A-Da-d1-9])\)$/.test(text) ||
  (qPunct === ')' && /^\d{1,3}\.$/.test(text)) ||
  (qPunct === '.' && /^\d{1,3}\)$/.test(text)) ||
  /^(?:true|false)[.)]?$/i.test(text);

/** Top Y of the first answer marker (option label / True / False) in the block,
 *  or null when the block has no answer structure at all. */
const firstAnswerY = (words: OcrWordBox[], qPunct: ')' | '.'): number | null => {
  let y: number | null = null;
  for (const w of words) {
    if (isAnswerLabelToken(w.text, qPunct) && (y === null || w.y0 < y)) y = w.y0;
  }
  return y;
};

/**
 * A block has a real STEM — substantive question text ABOVE the first answer
 * marker, excluding the question number and option labels. This is the guard
 * against an "options-only" crop (a bare number + options with no question), the
 * brief's `Q151 / option1 / option2` Bad case. Lenient: ≥2 stem words OR ≥8 stem
 * characters counts, so OCR that drops a word or two doesn't false-reject.
 */
export const hasStem = (words: OcrWordBox[], qPunct: ')' | '.'): boolean => {
  const ay = firstAnswerY(words, qPunct);
  const above = ay === null ? words : words.filter((w) => w.y0 < ay - 1);
  const stem = above.filter(
    (w) =>
      !QNUM_TOKEN_RE.test(w.text) &&
      !isAnswerLabelToken(w.text, qPunct) &&
      /[A-Za-z0-9]/.test(w.text),
  );
  const chars = stem.reduce((n, w) => n + w.text.length, 0);
  return stem.length >= 2 || chars >= 8;
};

/** Classify a question block from its words + the page's question punctuation. */
export const classifyBlock = (words: OcrWordBox[], qPunct: ')' | '.'): QuestionClass => {
  const text = words
    .map((w) => w.text)
    .join(' ')
    .toLowerCase();
  if (/assertion/.test(text) && /reason/.test(text)) return 'ASSERTION_REASON';
  if (/match/.test(text) && /(column|list|following)/.test(text)) return 'MATCH_THE_FOLLOWING';
  if (hasTrueFalse(words)) return 'TRUE_FALSE';
  if (optionLabels(words, qPunct).size >= 2) return 'MCQ';
  if (/(_{3,}|\.{4,}|fill in the blank)/.test(text)) return 'FILL_IN_THE_BLANK';
  if (/(diagram|figure|shown|graph|circuit)/.test(text)) return 'DIAGRAM_BASED';
  return 'UNKNOWN';
};

/** A block has a COMPLETE answer structure — it's safe to end the question here.
 *  An answer structure (options / True-False) ONLY completes the block when there
 *  is also a stem above it, so an options-only fragment never ends a question — it
 *  merges back into the stem it belongs to (see `mergeIncompleteRegions`). */
export const isCompleteBlock = (words: OcrWordBox[], qPunct: ')' | '.'): boolean => {
  if (hasTrueFalse(words)) return hasStem(words, qPunct);
  if (optionLabels(words, qPunct).size >= 2) return hasStem(words, qPunct);
  const cls = classifyBlock(words, qPunct);
  // Descriptive / fill-blank / diagram questions legitimately have no options —
  // accept them only when the block has enough content to be a real question.
  return (
    (cls === 'FILL_IN_THE_BLANK' || cls === 'DESCRIPTIVE' || cls === 'DIAGRAM_BASED') &&
    words.length >= 6
  );
};

/**
 * Cluster markers into reading columns by their left X. Markers whose left edges
 * are within `gap` belong to the same column; a larger jump starts a new column.
 * Each column's right edge is the next column's left edge (or the page width).
 * Returns columns left-to-right, markers within each sorted top-to-bottom.
 */
export const detectColumns = (markers: Marker[], pageWidth: number): Column[] => {
  if (markers.length === 0) return [];
  const byX = [...markers].sort((a, b) => a.x0 - b.x0);
  // A column gap is a big horizontal jump between marker left-edges. Columns are
  // ≥ ~25% of width apart for ≤4 columns; within a column x0 barely varies.
  const gap = Math.max(40, pageWidth * 0.1);
  const groups: Marker[][] = [];
  let cur: Marker[] = [];
  let lastX = Number.NEGATIVE_INFINITY;
  for (const m of byX) {
    if (cur.length === 0 || m.x0 - lastX <= gap) cur.push(m);
    else {
      groups.push(cur);
      cur = [m];
    }
    lastX = m.x0;
  }
  if (cur.length) groups.push(cur);

  const lefts = groups.map((g) => Math.min(...g.map((m) => m.x0)));
  return groups.map((g, i) => ({
    left: lefts[i],
    right: i + 1 < groups.length ? lefts[i + 1] : pageWidth,
    markers: [...g].sort((a, b) => a.y0 - b.y0),
  }));
};

/**
 * One region per question: (column x-range) × [marker.y, nextMarker.y). The next
 * marker in the SAME column terminates the region; the last marker runs to the
 * page bottom. Reading order: column-by-column (left→right), top→bottom within.
 */
export const buildRegions = (
  columns: Column[],
  pageWidth: number,
  pageHeight: number,
  medianH: number,
  padTop: number = Math.round(medianH * 0.4),
  padBottom: number = Math.round(medianH * 0.4),
): Region[] => {
  const padX = Math.round(medianH * 0.4);
  const regions: Region[] = [];
  for (const col of columns) {
    const x0 = Math.max(0, Math.round(col.left - padX));
    const x1 = Math.min(pageWidth, Math.round(col.right));
    // Collapse near-duplicate markers (same question, OCR jitter) so one question
    // never yields two sliver crops.
    const ys: number[] = [];
    for (const m of col.markers) {
      if (ys.length === 0 || m.y0 - ys[ys.length - 1] > medianH) ys.push(m.y0);
    }
    for (let i = 0; i < ys.length; i += 1) {
      // Top padding keeps the question NUMBER (and a little breathing room) inside
      // the crop; bottom padding controls how close to the next marker we stop.
      const y0 = Math.max(0, Math.round(ys[i] - padTop));
      const y1 = i + 1 < ys.length ? Math.round(ys[i + 1] - padBottom) : pageHeight;
      if (y1 - y0 >= medianH && x1 - x0 >= medianH) regions.push({ x0, y0, x1, y1 });
    }
  }
  return regions;
};

/** Best-effort option count from option markers in a region. Clamp 2..6; default 4. */
export const countOptionMarkers = (words: OcrWordBox[]): number => {
  const labels = new Set<string>();
  for (const w of words) {
    const m = w.text.match(OPTION_MARKER_RE);
    if (m) labels.add((m[1] ?? m[2]).toLowerCase());
  }
  const n = labels.size;
  return n >= 2 && n <= 6 ? n : 4;
};

const wordsInRegion = (words: OcrWordBox[], r: Region): OcrWordBox[] =>
  words.filter((w) => {
    const cx = (w.x0 + w.x1) / 2;
    const cy = (w.y0 + w.y1) / 2;
    return cx >= r.x0 && cx < r.x1 && cy >= r.y0 && cy < r.y1;
  });

/** The 0-based reading column a region belongs to (for the missing-question
 *  diagnostic). Single-column pages → 0. */
const columnIndexOf = (r: Region, columns: Column[]): number => {
  if (columns.length <= 1) return 0;
  const cx = (r.x0 + r.x1) / 2;
  for (let i = 0; i < columns.length; i += 1) {
    if (cx >= columns[i].left - 1 && cx < columns[i].right) return i;
  }
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < columns.length; i += 1) {
    const d = Math.abs(r.x0 - columns[i].left);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
};

/**
 * Validate-before-split: a candidate region is only a real question if its block
 * has a complete answer structure (options / true-false / enough descriptive
 * content). If a same-column region's block is INCOMPLETE, the marker that
 * started the NEXT region was likely a false positive (an option number, a value,
 * or OCR noise) — so we MERGE the two regions instead of splitting. Repeats until
 * the block is complete or the column ends. This stops "a crop per numeric
 * marker" and keeps one question (stem + all options) per crop.
 */
export const mergeIncompleteRegions = (
  regions: Region[],
  words: OcrWordBox[],
  qPunct: ')' | '.',
): Region[] => {
  const out: Region[] = [];
  for (const r of regions) {
    const prev = out[out.length - 1];
    const sameColumn = prev && prev.x0 === r.x0 && prev.x1 === r.x1;
    if (sameColumn && !isCompleteBlock(wordsInRegion(words, prev), qPunct)) {
      prev.y1 = r.y1; // absorb the false split — extend the previous question
    } else {
      out.push({ ...r });
    }
  }
  return out;
};

/**
 * Enforce the invariant **one question number per crop**. After geometric region
 * building, re-scan each region for additional question-start markers whose
 * number is greater than the region's own (option numbers are a different
 * punctuation family and are ignored), and split the region at each — even when
 * there is almost no whitespace between the two questions. This is the safety net
 * behind the merge-failure fix: a second question that slipped past column
 * clustering (or whose number was glued to its text) is still separated here.
 * The first sub-region keeps the parent's top so the leading question NUMBER is
 * never cropped away.
 */
export const splitRegionsByInternalMarkers = (
  regions: Region[],
  words: OcrWordBox[],
  medianH: number,
  qPunct: ')' | '.',
  padTop: number,
): Region[] => {
  const out: Region[] = [];
  for (const r of regions) {
    const rw = wordsInRegion(words, r);
    // Strict markers PLUS relaxed ones: a question-punct (or glued-big) number
    // hugging the region's far-left edge is a second question even when OCR merged
    // it onto the previous option's line (so it failed the line-start test). This
    // is what guarantees no crop keeps two question numbers (102+103, 110+111).
    const strict = findQuestionMarkers(rw, medianH, qPunct);
    const relaxed: Marker[] = [];
    for (const wd of rw) {
      if (wd.x0 - r.x0 > medianH * 1.5) continue; // not at the column's left edge
      if (OPTION_SHAPED_RE.test(wd.text)) continue; // never an option
      const pm = qPunct === '.' ? NUM_DOT_RE.exec(wd.text) : NUM_PAREN_RE.exec(wd.text);
      const gm = NUM_GLUED_RE.exec(wd.text);
      const num = pm ? +pm[1] : gm && +gm[1] > 8 ? +gm[1] : null;
      if (num !== null) relaxed.push({ x0: wd.x0, y0: wd.y0, num });
    }
    const ms = [...strict, ...relaxed].sort((a, b) => a.y0 - b.y0);
    // Collapse OCR jitter (markers within one line-height) and keep a strictly
    // increasing number run so option/stray/duplicate numbers never split.
    const kept: Marker[] = [];
    let lastY = Number.NEGATIVE_INFINITY;
    let lastNum = Number.NEGATIVE_INFINITY;
    for (const m of ms) {
      if (m.y0 - lastY <= medianH) continue;
      const num = m.num ?? NaN;
      if (!Number.isNaN(num) && num <= lastNum) continue;
      kept.push(m);
      lastY = m.y0;
      if (!Number.isNaN(num)) lastNum = num;
    }
    if (kept.length <= 1) {
      out.push(r);
      continue;
    }
    for (let i = 0; i < kept.length; i += 1) {
      // First piece keeps the region's existing top (number already inside);
      // subsequent pieces start one pad above their marker so the number stays in.
      const y0 = i === 0 ? r.y0 : Math.max(0, Math.round(kept[i].y0 - padTop));
      const y1 = i + 1 < kept.length ? Math.max(y0 + 1, Math.round(kept[i + 1].y0 - padTop)) : r.y1;
      out.push({ x0: r.x0, y0, x1: r.x1, y1 });
    }
  }
  return out;
};

/** Leading 1–3 digit integer of a token ("104" / "104." / "104Select" → 104),
 *  rejecting longer numbers (a 4-digit run is never a question number ≤ ~999). */
const leadingInt = (text: string): number | null => {
  const m = /^(\d{1,3})(?!\d)/.exec(stripLeadNoise((text ?? '').trim()));
  return m ? +m[1] : null;
};

/**
 * Sequence-gap recovery — the refinement for the 164→180 long tail.
 *
 * After the markered splits, a region may STILL hold a question whose number the
 * primary detector missed (watermark crossing the digits, lost punctuation, very
 * small gap to the previous options). Because question numbers are sequential, we
 * know the region's own number N and can search BELOW it for a line-start token
 * whose leading integer is exactly the next expected number (N+1, N+2, …) sitting
 * at the column's left margin. Targeting the SPECIFIC expected number — not any
 * integer — keeps false splits (in-text numbers, option digits) negligible, while
 * recovering a bare/garbled "104" that carried no question punctuation.
 */
export const recoverSequenceGaps = (
  regions: Region[],
  words: OcrWordBox[],
  medianH: number,
  qPunct: ')' | '.',
  padTop: number,
): Region[] => {
  const out: Region[] = [];
  for (const r of regions) {
    const rw = wordsInRegion(words, r);
    const top = findQuestionMarkers(rw, medianH, qPunct)[0];
    const baseNum = top?.num;
    if (baseNum === undefined || baseNum === null || Number.isNaN(baseNum)) {
      out.push(r);
      continue;
    }
    const topY = top.y0;
    // Line-start integers below the region's own number, near the column's left
    // margin (question numbers hug the left edge; in-text numbers sit deeper).
    const cands = rw
      .filter((wd) => {
        if (wd.y0 <= topY + medianH * 0.5) return false;
        const dx = wd.x0 - r.x0;
        if (dx > medianH * 4) return false;
        // Tiny-gap case: when there's almost no space between Q102's last option
        // and Q103, OCR can merge them onto one visual line, so Q103's number
        // fails the line-start test. A number hugging the column's far-left edge
        // is still a question start — accept it directly; deeper tokens must
        // genuinely start a line. (Downstream gates keep options out regardless.)
        return dx <= medianH * 1.5 || isLineStart(wd, rw, medianH);
      })
      .map((wd) => ({ y0: wd.y0, n: leadingInt(wd.text), text: wd.text }))
      .filter((c): c is { y0: number; n: number; text: string } => c.n !== null)
      .sort((a, b) => a.y0 - b.y0);

    const splitYs: number[] = [];
    let expected = baseNum + 1;
    let lastY = topY;
    for (const c of cands) {
      if (c.y0 - lastY <= medianH) continue; // jitter / same line
      // QUESTION vs OPTION discipline — the whole point of this pass:
      //  • an option shape ("(3)", "a)") is NEVER a question;
      //  • a SMALL bare number (≤ 8) is only a question when it carries the
      //    page's question punctuation ("4.") — a bare "4" or "(4)" is an option;
      //  • a number > 8 cannot be an option, so a glued/bare "104" is accepted.
      if (OPTION_SHAPED_RE.test(c.text)) continue;
      const big = c.n > 8;
      if (!big && !hasQuestionPunct(c.text, qPunct)) continue;
      // Accept the exact next number; for safe (big) numbers tolerate a 1–2 step
      // skip so an unreadable middle number doesn't stall the rest of the column.
      if (c.n === expected || (big && c.n > expected && c.n <= expected + 2)) {
        splitYs.push(c.y0);
        expected = c.n + 1;
        lastY = c.y0;
      }
    }
    if (splitYs.length === 0) {
      out.push(r);
      continue;
    }
    const tops = [r.y0, ...splitYs.map((y) => Math.max(0, Math.round(y - padTop)))];
    for (let i = 0; i < tops.length; i += 1) {
      const y0 = tops[i];
      const y1 = i + 1 < tops.length ? Math.max(y0 + 1, tops[i + 1]) : r.y1;
      if (y1 - y0 >= medianH) out.push({ x0: r.x0, y0, x1: r.x1, y1 });
    }
  }
  return out;
};

/**
 * Tight-pair number recovery. OCR sometimes TRUNCATES a question number — e.g.
 * "111." read as "1." when the leading digits are faint or merged — so the marker
 * is detected with the WRONG value, sequence validation discards it (1 < 110),
 * and that question merges into its predecessor (the 110+111 case). Using
 * sequence context we find a single-number gap between two consecutive kept
 * markers A and A+2 (so the missing number is E = A+1); if a stray line-start
 * marker sits BETWEEN them by Y, hugs the column's left margin, and its digits are
 * a TRUNCATION of E (a prefix or suffix of E, e.g. "1" of "111" or "11" of "110"),
 * we rewrite that word's text to E. Done BEFORE marker detection so every
 * downstream stage (markers → columns → regions → questionNumber) sees the real
 * number with no further special-casing. Mutates `words` in place; intentionally
 * narrow to avoid promoting options or unrelated strays.
 */
export const recoverTruncatedNumbers = (
  words: OcrWordBox[],
  pageWidth: number,
  medianH: number,
  qPunct: ')' | '.',
): void => {
  // Ceiling-free: this recovery must SEE a high spike (e.g. "270.") to correct it
  // to its in-sequence value; the out-of-range ceiling is applied later, at the
  // segmentation marker pass, so a corrected 170 survives and a true 273 is dropped.
  const markers = findQuestionMarkers(words, medianH, qPunct, Number.POSITIVE_INFINITY);
  if (markers.length < 3) return;
  for (const col of detectColumns(markers, pageWidth)) {
    const sorted = [...col.markers]
      .filter(
        (m): m is Marker & { num: number } => typeof m.num === 'number' && !Number.isNaN(m.num),
      )
      .sort((a, b) => a.y0 - b.y0);
    const kept: Array<Marker & { num: number }> = [];
    const strays: Array<Marker & { num: number }> = [];
    let last = Number.NEGATIVE_INFINITY;
    for (const m of sorted) {
      if (m.num > last) {
        kept.push(m);
        last = m.num;
      } else strays.push(m);
    }
    if (strays.length === 0) continue;
    const leftEdge = Math.min(...sorted.map((m) => m.x0));
    const filled = new Set<number>();
    for (const s of strays) {
      let above: (Marker & { num: number }) | undefined;
      let below: (Marker & { num: number }) | undefined;
      for (const k of kept) {
        if (k.y0 < s.y0) above = k;
        else if (k.y0 > s.y0 && !below) below = k;
      }
      if (!above || !below || below.num !== above.num + 2) continue; // not a single-number gap
      const E = above.num + 1;
      if (filled.has(E)) continue;
      const sd = String(s.num);
      if (!(String(E).startsWith(sd) || String(E).endsWith(sd))) continue; // not a truncation of E
      if (s.x0 - leftEdge > medianH * 1.5) continue; // must hug the column's left margin
      const w = words.find((wd) => wd.x0 === s.x0 && wd.y0 === s.y0);
      if (!w) continue;
      w.text = w.text.replace(/^(\D*)(\d{1,3})/, `$1${E}`);
      filled.add(E);
    }
  }
};

/**
 * Century-misread recovery. OCR sometimes corrupts a question number's LEADING
 * digit — e.g. "170." read as "270." (1→2) — producing a value far above the run.
 * Greedy sequence validation then KEEPS the spike (270 > 168) and DROPS the real
 * next question (171 < 270), merging two questions into one crop AND mislabelling
 * the draft (270). Using sequence context we find a marker that leaps over a
 * SMALLER later continuation in its column (last < later < m); if subtracting a
 * whole hundred lands it back in-sequence (last < m−100k < later) we rewrite that
 * word's leading number to the corrected value — BEFORE marker detection — so the
 * number is fixed AND the next question survives validation. Mutates `words` in
 * place; deliberately narrow (only fires on a real over-leap with an exact
 * in-sequence century correction), so normal sequences are untouched.
 */
export const recoverCenturyMisreads = (
  words: OcrWordBox[],
  pageWidth: number,
  medianH: number,
  qPunct: ')' | '.',
): void => {
  // Ceiling-free: this recovery must SEE a high spike (e.g. "270.") to correct it
  // to its in-sequence value; the out-of-range ceiling is applied later, at the
  // segmentation marker pass, so a corrected 170 survives and a true 273 is dropped.
  const markers = findQuestionMarkers(words, medianH, qPunct, Number.POSITIVE_INFINITY);
  if (markers.length < 3) return;
  for (const col of detectColumns(markers, pageWidth)) {
    const sorted = [...col.markers]
      .filter(
        (m): m is Marker & { num: number } => typeof m.num === 'number' && !Number.isNaN(m.num),
      )
      .sort((a, b) => a.y0 - b.y0);
    let last = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < sorted.length; i += 1) {
      const m = sorted[i];
      if (m.num <= last) continue;
      const later = sorted.slice(i + 1).find((o) => o.num > last && o.num < m.num);
      if (!later) {
        last = m.num; // normal increasing step
        continue;
      }
      // m leapt over a smaller later continuation → an OCR spike. Correct it by
      // removing whole hundreds if that lands strictly between `last` and `later`.
      // The correction MUST be a positive question number: when `last` is -∞ (m is
      // the first marker in its column) an unguarded `c > last` would accept a
      // NEGATIVE candidate — e.g. a correct "41." sitting above a stray "12." marker
      // would be "corrected" to 41-100=-59, which then re-parses as 59 and merges
      // the column. `Math.max(last, 0)` floors the search at a real question number.
      let corrected: number | null = null;
      for (let c = m.num - 100; c > Math.max(last, 0); c -= 100) {
        if (c < later.num) {
          corrected = c;
          break;
        }
      }
      if (corrected !== null) {
        const w = words.find((wd) => wd.x0 === m.x0 && wd.y0 === m.y0);
        if (w) w.text = w.text.replace(/^(\D*)(\d{1,3})/, `$1${corrected}`);
        last = corrected;
      }
      // not correctable → leave m untouched and do NOT advance `last`, so a real
      // later continuation is still evaluated against the prior in-sequence value.
    }
  }
};

/* ─────────────────────────────────────────── Segmentation quality report */

export interface MultiQuestionCrop {
  position: number;
  numbers: number[];
}

/** Per-page record of what each pipeline STAGE saw, so a missing question can be
 *  traced to the exact stage where it disappeared. */
export interface PageMarkerTrace {
  page: number;
  /** Detected reading-column count on the page (1 = single column). */
  columnCount: number;
  /** Every number OCR surfaced anywhere on the page, with its token position. */
  ocrNumbers: Array<{ num: number; x: number; y: number }>;
  /** Numbers that marker detection (findQuestionMarkers) accepted. */
  markerNumbers: number[];
  /** Numbers that survived per-column sequence validation. */
  keptNumbers: number[];
}

/** Where a missing question disappeared in the pipeline. */
export type MissingStage =
  | 'OCR_MISS' // OCR never read the number
  | 'MARKER_MISS' // read, but marker detection rejected it (line-start / punct)
  | 'SEQUENCE_REMOVED' // marker found, but sequence validation dropped it
  | 'NOT_SPLIT' // kept, but region building merged it into a neighbour
  | 'UNKNOWN';

/** Per-missing-question diagnostic — pinpoints WHERE a gap is so its cause (page
 *  break / watermark / table / tiny gap / failed number read) is obvious. */
export interface MissingQuestionDiag {
  expected: number;
  previous: number | null;
  next: number | null;
  page: number | null;
  column: string | null;
  /** Pipeline-stage trace (populated when page traces are supplied). */
  ocrDetected: boolean;
  markerDetected: boolean;
  removedInSequence: boolean;
  /** The draft number that swallowed this question, when it was merged. */
  mergedIntoDraft: number | null;
  stage: MissingStage;
}

export interface SegmentationQualityReport {
  /** Target question count (provided, else inferred from the max detected number). */
  expected: number | null;
  detected: number;
  coveragePct: number;
  /** Question numbers in 1..expected that no crop covers. */
  missingNumbers: number[];
  /** One diagnostic row per missing number (prev/next/page/column). */
  missing: MissingQuestionDiag[];
  /** Question numbers that more than one crop claims. */
  duplicateNumbers: number[];
  /** Crops whose OCR text contains more than one question number (should be 0). */
  multiQuestionCrops: MultiQuestionCrop[];
  /** Positions of crops where no question number could be read (number lost). */
  missingQuestionNumberPositions: number[];
  /** Crops with no question number/stem/marker — not counted as questions. */
  invalidCrops: number;
  /** Crops flagged for manual review (low segmentation confidence). */
  needsManualReview: number;
}

// Scan a crop's OCR text for question numbers ("103." / "104)") — a digit right
// after the punctuation is rejected so decimals don't count. Used only to FLAG a
// crop that still contains two questions; not a primary segmentation signal.
const CROP_QNUM_SCAN_RE = /(?:^|\s)(\d{1,3})[.)](?!\d)/g;

/** Human label for a 0-based column index given the page's column count. */
const columnLabel = (col?: number | null, count?: number | null): string | null => {
  if (col === undefined || col === null) return null;
  if (!count || count <= 1) return 'Single';
  if (col === 0) return 'Left';
  if (col === 1 && count === 2) return 'Right';
  return `Col ${col + 1}`;
};

interface ReportDraft {
  position: number;
  questionNumber?: number | null;
  text?: string;
  needsImageReview?: boolean;
  invalidCrop?: boolean;
  sourcePageNumber?: number | null;
  sourceColumn?: number | null;
  sourceColumnCount?: number | null;
  sourceCoordinates?: { x0: number; y0: number; x1: number; y1: number } | null;
}

/** Classify where a missing number disappeared, using the per-page stage traces
 *  and the final drafts (to find which draft swallowed a merged number). */
const traceMissing = (
  n: number,
  traces: PageMarkerTrace[],
  drafts: ReportDraft[],
): Pick<
  MissingQuestionDiag,
  'ocrDetected' | 'markerDetected' | 'removedInSequence' | 'mergedIntoDraft' | 'stage'
> & {
  page: number | null;
  column: string | null;
} => {
  let ocrPos: { page: number; x: number; y: number } | null = null;
  let markerDetected = false;
  let kept = false;
  for (const t of traces) {
    const hit = t.ocrNumbers.find((o) => o.num === n);
    if (hit && !ocrPos) ocrPos = { page: t.page, x: hit.x, y: hit.y };
    if (t.markerNumbers.includes(n)) markerDetected = true;
    if (t.keptNumbers.includes(n)) kept = true;
  }
  const ocrDetected = ocrPos !== null;
  const removedInSequence = markerDetected && !kept;

  // If a draft's region on the same page contains the number's token, it was
  // merged into that draft.
  let mergedIntoDraft: number | null = null;
  let page: number | null = ocrPos?.page ?? null;
  let column: string | null = null;
  if (ocrPos) {
    const host = drafts.find(
      (d) =>
        d.sourcePageNumber === ocrPos!.page &&
        d.sourceCoordinates != null &&
        ocrPos!.x >= d.sourceCoordinates.x0 - 2 &&
        ocrPos!.x < d.sourceCoordinates.x1 + 2 &&
        ocrPos!.y >= d.sourceCoordinates.y0 - 2 &&
        ocrPos!.y < d.sourceCoordinates.y1 + 2,
    );
    if (host) {
      mergedIntoDraft = host.questionNumber ?? null;
      page = host.sourcePageNumber ?? page;
      column = columnLabel(host.sourceColumn, host.sourceColumnCount);
    }
  }

  let stage: MissingStage;
  if (!ocrDetected) stage = 'OCR_MISS';
  else if (!markerDetected) stage = 'MARKER_MISS';
  else if (removedInSequence) stage = 'SEQUENCE_REMOVED';
  else if (mergedIntoDraft !== null) stage = 'NOT_SPLIT';
  else stage = 'UNKNOWN';

  return { ocrDetected, markerDetected, removedInSequence, mergedIntoDraft, stage, page, column };
};

/**
 * Build the pre-review quality report. Never silently accept missing numbers:
 * the caller logs this and the FE surfaces it so a teacher knows coverage before
 * reviewing. `expectedTotal` (e.g. 180 for RE NEET PST 3) overrides the inferred
 * target; without it we infer from the largest detected number / crop count.
 * Pass `pageTraces` to trace each missing number to the stage it disappeared.
 */
export const buildQualityReport = (
  drafts: ReportDraft[],
  expectedTotal?: number | null,
  pageTraces: PageMarkerTrace[] = [],
): SegmentationQualityReport => {
  // Invalid crops are not real questions — exclude them from coverage entirely.
  const validDrafts = drafts.filter((d) => !d.invalidCrop);
  const invalidCrops = drafts.length - validDrafts.length;
  const detected = validDrafts.length;
  const nums = validDrafts
    .map((d) => d.questionNumber)
    .filter((n): n is number => typeof n === 'number' && !Number.isNaN(n));

  // First crop seen for each question number — the anchor for missing-gap diagnostics.
  const draftByNum = new Map<number, ReportDraft>();
  for (const d of validDrafts) {
    const n = d.questionNumber;
    if (typeof n === 'number' && !Number.isNaN(n) && !draftByNum.has(n)) draftByNum.set(n, d);
  }

  const counts = new Map<number, number>();
  for (const n of nums) counts.set(n, (counts.get(n) ?? 0) + 1);
  const duplicateNumbers = [...counts.entries()]
    .filter(([, c]) => c > 1)
    .map(([n]) => n)
    .sort((a, b) => a - b);

  const minNum = nums.length ? Math.min(...nums) : 0;
  const maxNum = nums.length ? Math.max(...nums) : 0;
  // Missing-number RANGE. With an explicit full-paper target (expectedTotal) the
  // paper is assumed to start at Q1, so we count 1..expectedTotal. Otherwise this
  // is a PAGE-RANGE extract (e.g. questions 89–113): numbers below the first
  // detected question are simply NOT in this PDF — counting them as "missing"
  // fabricated 84 phantom gaps and crushed coverage to 20%. So infer the range as
  // [minDetected..maxDetected] and report `expected` as that span's question count.
  const hasTarget = !!(expectedTotal && expectedTotal > 0);
  const lo = hasTarget ? 1 : minNum || 1;
  const hi = hasTarget ? (expectedTotal as number) : maxNum;
  const expected = hi ? (hasTarget ? (expectedTotal as number) : hi - lo + 1) : detected || null;

  const missingNumbers: number[] = [];
  if (hi) {
    const present = new Set(nums);
    for (let n = lo; n <= hi; n += 1) if (!present.has(n)) missingNumbers.push(n);
  }

  // Diagnostic row per missing number: previous/next detected numbers + the page
  // and column of the nearest neighbour (where the missing question should sit).
  const sortedNums = [...new Set(nums)].sort((a, b) => a - b);
  const missing: MissingQuestionDiag[] = missingNumbers.map((N) => {
    let previous: number | null = null;
    let next: number | null = null;
    for (const n of sortedNums) {
      if (n < N) previous = n;
      else if (n > N) {
        next = n;
        break;
      }
    }
    const t = traceMissing(N, pageTraces, drafts);
    // Fall back to a neighbour's page/column when the trace couldn't locate the
    // number (e.g. OCR never read it).
    const ref =
      (previous !== null ? draftByNum.get(previous) : undefined) ??
      (next !== null ? draftByNum.get(next) : undefined);
    return {
      expected: N,
      previous,
      next,
      page: t.page ?? ref?.sourcePageNumber ?? null,
      column: t.column ?? columnLabel(ref?.sourceColumn, ref?.sourceColumnCount),
      ocrDetected: t.ocrDetected,
      markerDetected: t.markerDetected,
      removedInSequence: t.removedInSequence,
      mergedIntoDraft: t.mergedIntoDraft,
      stage: t.stage,
    };
  });

  const multiQuestionCrops: MultiQuestionCrop[] = [];
  for (const d of validDrafts) {
    if (!d.text) continue;
    const found = new Set<number>();
    CROP_QNUM_SCAN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CROP_QNUM_SCAN_RE.exec(d.text))) found.add(+m[1]);
    if (found.size >= 2)
      multiQuestionCrops.push({ position: d.position, numbers: [...found].sort((a, b) => a - b) });
  }

  const missingQuestionNumberPositions = validDrafts
    .filter((d) => d.questionNumber == null || Number.isNaN(d.questionNumber))
    .map((d) => d.position);

  const needsManualReview = drafts.filter((d) => d.needsImageReview).length;
  // Coverage = in-range questions present / in-range questions expected. Derived
  // from the missing count so a page-range extract reads honestly (88%, not 20%).
  const coveragePct = expected
    ? Math.round(((expected - missingNumbers.length) / expected) * 100)
    : 100;

  return {
    expected: expected ?? null,
    detected,
    coveragePct,
    missingNumbers,
    missing,
    duplicateNumbers,
    multiQuestionCrops,
    missingQuestionNumberPositions,
    invalidCrops,
    needsManualReview,
  };
};

/** Stitch two PNG crops vertically (top over bottom) into one PNG — used to
 *  merge a question's tail from the next page into a single screenshot. */
const stitchVertical = async (top: Buffer, bottom: Buffer): Promise<Buffer> => {
  const [tm, bm] = await Promise.all([sharp(top).metadata(), sharp(bottom).metadata()]);
  const th = tm.height ?? 0;
  const w = Math.max(tm.width ?? 0, bm.width ?? 0);
  const h = th + (bm.height ?? 0);
  if (w === 0 || h === 0) return top;
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      { input: top, top: 0, left: 0 },
      { input: bottom, top: th, left: 0 },
    ])
    .png()
    .toBuffer();
};

/**
 * Segmentation confidence — INDEPENDENT of OCR confidence. Starts at 1 and drops
 * when the crop looks risky: too few options, too little content, begins near the
 * page bottom, or ends at the page boundary (so it may continue onto the next
 * page). Crops below 0.6 are flagged for manual review.
 */
const regionConfidence = (
  r: Region,
  regionWords: OcrWordBox[],
  pageHeight: number,
  optionCount: number,
  isLast: boolean,
): number => {
  let c = 1;
  if (optionCount < 2) c -= 0.25; // a question should expose ≥2 options
  if (regionWords.length < 5) c -= 0.25; // barely any content
  if (r.y0 > pageHeight * 0.85) c -= 0.2; // starts near the page bottom
  if (isLast && r.y1 >= pageHeight - 2) c -= 0.2; // ends at the page boundary
  return Math.max(0.1, Math.min(1, c));
};

/** Carried-over state when a page's last question runs to the page bottom and may
 *  continue on the next page. Holds enough to stitch + back-patch the draft. */
export interface SegmentCarry {
  cropBytes: Buffer;
  key: string;
  draft: OcrEngineDraft;
}

/**
 * Detect column-aware question regions on a page, crop each to a PNG, upload it,
 * and return one VISUAL draft per region (positions offset by `positionOffset`).
 *
 * Page-boundary handling (A): if `carryIn` is set (the previous page's last
 * question ran to its bottom), the content ABOVE this page's first question
 * marker is that question's tail — it is cropped and stitched onto the previous
 * crop (one question = one crop across pages). If THIS page's last region ends at
 * the page bottom, it is returned as `carryOut` for the next page to continue.
 *
 * Each draft carries a segmentation `confidence` (D) and is flagged
 * `needsImageReview` when low. Blank regions are rejected (B).
 */
export const segmentVisualDrafts = async (
  pageImage: Buffer,
  rawWords: OcrWordBox[],
  pageNumber: number,
  opts: {
    putObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
    figureKeyPrefix: string;
    positionOffset?: number;
    carryIn?: SegmentCarry | null;
    /** DISPLAY-ONLY: the cross-page flat field, used to suppress the watermark
     *  from the stored crop PIXELS. Does not affect any draft field / detection
     *  (those are already computed from word boxes). Absent → no display cleanup. */
    displayFlat?: import('./watermark-clean').FlatField | null;
    /** DISPLAY-ONLY: page-level large-watermark mask. Gates the crop cleanup so a
     *  pixel may be whitened only if it lies inside a large persistent watermark
     *  blob; thin lines, small labels and page codes are always kept. Absent →
     *  flat-field guards only (back-compat). */
    displayMask?: import('./watermark-clean').WatermarkMask | null;
    /** DISPLAY-ONLY: pixel source for the saved crop. The pre-OCR flat-field
     *  division (`cleanPageImage`) can brighten dark ink toward white, losing a
     *  little content; cropping the SHOWN image from the RAW page avoids that.
     *  OCR/segmentation still use the cleaned page's word boxes — unchanged. Same
     *  dimensions as `pageImage`. Absent → crop from `pageImage` (back-compat). */
    displaySource?: Buffer;
  },
): Promise<{ drafts: OcrEngineDraft[]; carryOut: SegmentCarry | null; trace: PageMarkerTrace }> => {
  const emptyTrace: PageMarkerTrace = {
    page: pageNumber,
    columnCount: 0,
    ocrNumbers: [],
    markerNumbers: [],
    keptNumbers: [],
  };
  const meta = await sharp(pageImage).metadata();
  const pageWidth = meta.width ?? 0;
  const pageHeight = meta.height ?? 0;
  if (!pageWidth || !pageHeight) return { drafts: [], carryOut: null, trace: emptyTrace };

  // Watermark/branding stamps (e.g. "CC-315") that repeat down the page can sit
  // to the LEFT of a real question number and make it fail the line-start test —
  // dropping them BEFORE marker detection recovers those numbers. But the filter
  // must NEVER remove a question NUMBER itself, so any question-number-shaped
  // token the filter dropped is added back (suppress watermark tokens only).
  const filtered = filterRepeatedWatermarks(rawWords);
  const kept = new Set(filtered);
  const restored = rawWords.filter((w) => !kept.has(w) && isQuestionNumberToken(w.text));
  const words = restored.length > 0 ? [...filtered, ...restored] : filtered;

  const medianH = medianHeight(words);
  const qPunct = detectQuestionPunct(words, medianH);
  // Configurable crop padding (multiples of the median word height). Top padding
  // is a touch more generous so a question number that OCR placed slightly high
  // is never cropped away; both are tunable via env per paper layout.
  const padRatio = (name: string, dflt: number): number => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= 0 ? v : dflt;
  };
  const padTop = Math.round(medianH * padRatio('OCR_CROP_PAD_TOP_RATIO', 0.6));
  const padBottom = Math.round(medianH * padRatio('OCR_CROP_PAD_BOTTOM_RATIO', 0.4));
  // Question-START driven pipeline:
  //  1) detect markers (tolerant of glued numbers) → cluster into reading columns
  //  2) per-column sequence validation drops option/stray numbers (no whitespace
  //     dependence) — this is what keeps dense questions apart
  //  3) buildRegions splits each column at every validated marker
  //  4) splitRegionsByInternalMarkers enforces ONE question number per crop, the
  //     safety net for any second question that slipped past column clustering
  // Tight-pair recovery: rewrite an OCR-truncated question number (e.g. "111."
  // read as "1.") back to its sequence-correct value BEFORE marker detection, so
  // it survives sequence validation and becomes its own crop instead of merging
  // into the previous question.
  recoverTruncatedNumbers(words, pageWidth, medianH, qPunct);
  // Century-misread recovery: rewrite a leading-digit corruption (e.g. "170." read
  // as "270.") back to its sequence-correct value, so the spike can't evict the
  // next question (171) and the draft is numbered 170 — not 270.
  recoverCenturyMisreads(words, pageWidth, medianH, qPunct);
  // No markers detected (pure diagram page) → one full-page crop, never dropped.
  const markers = findQuestionMarkers(words, medianH, qPunct);
  const columns = validateMarkerSequence(detectColumns(markers, pageWidth));

  // Pipeline-stage trace — what each stage saw, so a missing question can be
  // pinned to OCR / marker / sequence / region-build (see buildQualityReport).
  const numFromTrace = (n: number | undefined): n is number =>
    typeof n === 'number' && !Number.isNaN(n);
  const trace: PageMarkerTrace = {
    page: pageNumber,
    columnCount: columns.length,
    ocrNumbers: rawWords
      .map((wd) => ({ num: leadingInt(wd.text), x: wd.x0, y: wd.y0 }))
      .filter((o): o is { num: number; x: number; y: number } => o.num !== null),
    markerNumbers: markers.map((m) => m.num).filter(numFromTrace),
    keptNumbers: columns.flatMap((c) => c.markers.map((m) => m.num)).filter(numFromTrace),
  };
  const regions: Region[] =
    columns.length > 0
      ? recoverSequenceGaps(
          splitRegionsByInternalMarkers(
            buildRegions(columns, pageWidth, pageHeight, medianH, padTop, padBottom),
            words,
            medianH,
            qPunct,
            padTop,
          ),
          words,
          medianH,
          qPunct,
          padTop,
        )
      : [{ x0: 0, y0: 0, x1: pageWidth, y1: pageHeight }];

  // (A) Continuation: stitch the previous page's incomplete question with the
  // content above this page's first marker (in the first column).
  if (opts.carryIn && columns.length > 0) {
    const firstCol = columns[0];
    const firstMarkerY = Math.min(...firstCol.markers.map((m) => m.y0));
    const headerH = Math.round(firstMarkerY - medianH * 0.4);
    if (headerH >= medianH) {
      const hx0 = Math.max(0, Math.round(firstCol.left - medianH * 0.4));
      const hx1 = Math.min(pageWidth, Math.round(firstCol.right));
      const header = await sharp(opts.displaySource ?? pageImage)
        .extract({ left: hx0, top: 0, width: hx1 - hx0, height: headerH })
        .png()
        .toBuffer();
      const stitched = await stitchVertical(opts.carryIn.cropBytes, header);
      await opts.putObject(opts.carryIn.key, stitched, 'image/png'); // overwrite previous crop
      opts.carryIn.draft.spanPageEnd = pageNumber;
      // A stitched cross-page crop is heuristic — keep it visible for review.
      opts.carryIn.draft.confidence = Math.min(opts.carryIn.draft.confidence ?? 1, 0.55);
      opts.carryIn.draft.needsImageReview = true;
    }
  }

  const offset = opts.positionOffset ?? 0;
  const drafts: OcrEngineDraft[] = [];
  let carryOut: SegmentCarry | null = null;
  for (let i = 0; i < regions.length; i += 1) {
    const r = regions[i];
    const width = Math.min(pageWidth - r.x0, r.x1 - r.x0);
    const height = Math.min(pageHeight - r.y0, r.y1 - r.y0);
    if (width <= 0 || height <= 0) continue;
    const regionWords = wordsInRegion(words, r);
    // (B) Reject blank regions — nothing to crop (keeps the no-marker full-page case).
    if (regionWords.length === 0 && columns.length > 0) continue;

    // Crop the SHOWN image from the raw page when provided (avoids the pre-OCR
    // flat-field division's slight brightening of dark ink); detection is unchanged.
    const cropSource = opts.displaySource ?? pageImage;
    const crop = await sharp(cropSource)
      .extract({ left: r.x0, top: r.y0, width, height })
      .png()
      .toBuffer();
    // DISPLAY-ONLY watermark cleanup of the crop PIXELS (no effect on any draft
    // field — questionNumber/options/region were all derived from word boxes
    // above). Best-effort: returns the original bytes if disabled or on error.
    const displayCrop = opts.displayFlat
      ? await (
          await import('./crop-display-clean')
        ).cleanCropForDisplay(crop, {
          flat: opts.displayFlat,
          mask: opts.displayMask,
          region: { x0: r.x0, y0: r.y0, x1: r.x0 + width, y1: r.y0 + height },
          pageWidth,
          pageHeight,
        })
      : crop;
    const key = `${opts.figureKeyPrefix}/question-p${pageNumber}-${offset + drafts.length}-${randomUUID().slice(0, 8)}.png`;
    await opts.putObject(key, displayCrop, 'image/png');

    const optionCount = countOptionMarkers(regionWords);
    const questionClass = classifyBlock(regionWords, qPunct);
    // The number at the top of this crop — drives coverage/missing reporting and
    // reliable answer-key mapping. Null when OCR didn't surface a number.
    const topMarker = findQuestionMarkers(regionWords, medianH, qPunct)[0];
    const questionNumber =
      topMarker && topMarker.num !== undefined && !Number.isNaN(topMarker.num)
        ? topMarker.num
        : null;
    const isLast = i === regions.length - 1;
    let confidence = regionConfidence(r, regionWords, pageHeight, optionCount, isLast);
    // An unclassifiable block (no recognised answer structure) is a weak crop —
    // flag it so the teacher reviews/re-crops it rather than trusting it blindly.
    if (questionClass === 'UNKNOWN') confidence = Math.max(0.1, confidence - 0.2);
    // Options without a stem above them = a stem-less crop (the brief's
    // "begins with options, no question" Bad case) that survived merging because
    // its stem is off-page. Never trust it silently — push it into manual review.
    if (questionClass === 'MCQ' && !hasStem(regionWords, qPunct))
      confidence = Math.max(0.1, confidence - 0.3);
    // Final crop validation: a valid draft must carry a question number, a
    // question marker, OR a real stem. A crop with none (only options / a diagram
    // fragment / watermark / footer — the "Draft #40/#74" case) is marked
    // INVALID_CROP: flagged for review and not counted as a real question.
    const invalidCrop =
      columns.length > 0 && questionNumber === null && !hasStem(regionWords, qPunct);
    if (invalidCrop) confidence = Math.min(confidence, 0.3);
    const draft: OcrEngineDraft = {
      position: offset + drafts.length,
      text: regionWords.map((w) => w.text).join(' '), // metadata only — never rendered
      detectedType: 'VISUAL',
      questionClass,
      confidence,
      sourcePageNumber: pageNumber,
      spanPageStart: pageNumber,
      questionSnapshotKey: key,
      optionCount,
      questionNumber,
      sourceColumn: columnIndexOf(r, columns),
      sourceColumnCount: columns.length,
      invalidCrop,
      sourceCoordinates: { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 },
    };
    if (confidence < 0.6 || invalidCrop) draft.needsImageReview = true;
    drafts.push(draft);

    // (A) The last region ends at the page bottom → it may continue next page.
    if (isLast && r.y1 >= pageHeight - 2 && columns.length > 0) {
      carryOut = { cropBytes: displayCrop, key, draft };
    }
  }
  return { drafts, carryOut, trace };
};
