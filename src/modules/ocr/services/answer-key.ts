/**
 * Answer-key import — pure parsing + mapping (no I/O).
 *
 * A teacher uploads or pastes an answer key ("1-A 2-C 3-B …") alongside an OCR
 * import; we parse it into number→answer entries, then map those onto the job's
 * drafts by each draft's detected question number. Matched drafts get their
 * correct answer pre-filled so review becomes exception-only instead of
 * hand-picking every answer.
 *
 * The use-case (import-answer-key.use-case.ts) handles OCR + persistence; this
 * module stays pure so the parsing/mapping rules are exhaustively unit-tested.
 */

import type { SuggestedAnswer } from '../models/ocr-draft.model';

/* ───────────────────────────────────────────────────────────── Parsing */

export interface AnswerToken {
  /** The token exactly as written in the key ("A", "3", "TRUE"). */
  raw: string;
  /** 1-based option position for letter (A→1) / digit (3→3) answers. */
  correctIndex?: number;
  /** Boolean answer for True/False keys (full-word TRUE/FALSE only). */
  correct?: boolean;
}

export interface ParsedAnswerKey {
  entries: Map<number, AnswerToken>;
  /** Question numbers that appeared more than once with DIFFERENT answers — kept
   *  out of `entries` (ambiguous) and surfaced for the teacher to resolve. */
  conflicts: number[];
}

// "1-A" "1. A" "1) A" "1 A" "12=B" "7 → D" "3: TRUE". A separator OR whitespace
// between the number and the answer is required (the \b before the answer can't
// fall between two word chars like "1A"), which avoids reading "123" as 12→3.
// Alternation is ordered so full-word TRUE/FALSE wins before single letters.
const ENTRY_RE = /\b(\d{1,3})\s*[-–—.):=>→]*\s*\b(TRUE|FALSE|[A-H]|[1-8])\b/gi;

const tokenFor = (rawAnswer: string): AnswerToken => {
  const up = rawAnswer.toUpperCase();
  if (up === 'TRUE') return { raw: rawAnswer, correct: true };
  if (up === 'FALSE') return { raw: rawAnswer, correct: false };
  if (/^[A-H]$/.test(up)) return { raw: rawAnswer, correctIndex: up.charCodeAt(0) - 64 };
  return { raw: rawAnswer, correctIndex: Number(up) }; // 1..8
};

const sameAnswer = (a: AnswerToken, b: AnswerToken): boolean =>
  a.correctIndex === b.correctIndex && a.correct === b.correct;

/** Parse free-form answer-key text into number→answer entries. Tolerant of
 *  multi-column / multi-per-line layouts (scans the whole blob). Conflicting
 *  duplicates are dropped from `entries` and reported in `conflicts`. */
export const parseAnswerKey = (text: string): ParsedAnswerKey => {
  const entries = new Map<number, AnswerToken>();
  const conflicts = new Set<number>();
  if (!text) return { entries, conflicts: [] };

  ENTRY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENTRY_RE.exec(text))) {
    const num = Number(m[1]);
    const token = tokenFor(m[2]);
    const existing = entries.get(num);
    if (existing && !sameAnswer(existing, token)) {
      conflicts.add(num);
      entries.delete(num);
    } else if (!conflicts.has(num)) {
      entries.set(num, token);
    }
  }
  return { entries, conflicts: [...conflicts].sort((a, b) => a - b) };
};

/* ───────────────────────────────────────────────────────────── Mapping */

// Leading question number on a draft's OCR text: "151. …", "Q.151 …", "Question 1 …".
const DRAFT_NUM_RE = /^\s*(?:Q(?:uestion)?\.?\s*)?(\d{1,3})\s*[.)\s]/i;

/** The question number a draft represents, parsed from its leading OCR token,
 *  or null when the text has no recognizable leading number. */
export const detectDraftNumber = (text: string): number | null => {
  const m = DRAFT_NUM_RE.exec(text ?? '');
  return m ? Number(m[1]) : null;
};

export interface DraftRef {
  id: string;
  text: string;
  /** AUTHORITATIVE question number. This — not the OCR text or any index — is the
   *  identity used for mapping, so reordered/inserted drafts map correctly. Only
   *  when it's null do we fall back to parsing the number from `text`. */
  questionNumber?: number | null;
  /** Detected answer-slot count (2..6); bounds index answers when known. */
  optionCount?: number | null;
}

export interface AnswerAssignment {
  draftId: string;
  questionNumber: number;
  suggestedAnswer: SuggestedAnswer;
}

export interface AssignmentReport {
  assignments: AnswerAssignment[];
  /** Draft ids with no leading number, or a number absent from the key. */
  unmatchedDraftIds: string[];
  /** Key numbers that matched no draft. */
  unmatchedKeyNumbers: number[];
  /** Key numbers whose index answer exceeds the draft's optionCount. */
  outOfRangeNumbers: number[];
}

/**
 * Map parsed key entries onto drafts by detected question number. An index
 * answer beyond a draft's optionCount is rejected (reported, not assigned) — a
 * sign of a mis-OCR'd key or a wrong-paper key, which the teacher should see.
 */
export const assignAnswersToDrafts = (
  drafts: DraftRef[],
  key: ParsedAnswerKey,
): AssignmentReport => {
  const assignments: AnswerAssignment[] = [];
  const unmatchedDraftIds: string[] = [];
  const outOfRangeNumbers: number[] = [];
  const usedKeyNumbers = new Set<number>();

  for (const d of drafts) {
    // Identity = the persisted question number; fall back to the OCR text only
    // when it's absent (legacy drafts processed before questionNumber existed).
    const num = d.questionNumber ?? detectDraftNumber(d.text);
    const token = num !== null ? key.entries.get(num) : undefined;
    if (num === null || !token) {
      unmatchedDraftIds.push(d.id);
      continue;
    }
    if (
      token.correctIndex !== undefined &&
      d.optionCount != null &&
      token.correctIndex > d.optionCount
    ) {
      outOfRangeNumbers.push(num);
      unmatchedDraftIds.push(d.id);
      continue;
    }
    usedKeyNumbers.add(num);
    assignments.push({
      draftId: d.id,
      questionNumber: num,
      suggestedAnswer: { source: 'answer-key', ...token },
    });
  }

  const unmatchedKeyNumbers = [...key.entries.keys()]
    .filter((n) => !usedKeyNumbers.has(n))
    .sort((a, b) => a - b);

  return {
    assignments,
    unmatchedDraftIds,
    unmatchedKeyNumbers,
    outOfRangeNumbers: [...new Set(outOfRangeNumbers)].sort((a, b) => a - b),
  };
};
