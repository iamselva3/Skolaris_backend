import { Detector, DetectorContext, Finding, PaperDetectorContext, ShadowDraft } from './contracts';
import { detectMultiColumnPage } from './multi-column';
import { classifyWideContentFromShadow } from './wide-content';
import { detectSplitOrphans } from './split-question';
import { detectCrossPageContinuations } from './cross-page';
import { detectHandwrittenMarkers } from './handwritten';
import { detectExplanationBlocks } from './explanation';

/**
 * The 8 INDEPENDENT detectors — Phase 1 STUBS. Each conforms to the `Detector` contract and
 * declares its explainability basis (geometry / semantics / ocr), but its `detect()` behaviour
 * is NOT implemented yet: every stub returns [] (shadow NO-OP). Behaviour for each detector is a
 * separate, individually-authorized step that must prove clean-paper non-regression before its
 * auto-fix tier is enabled.
 *
 * Independence: a detector reads only `ctx` (the shared feature bus + read-only OCR output) and
 * never another detector's output. No detector here references another.
 */

abstract class ShadowDetector implements Detector {
  abstract readonly name: string;
  abstract readonly order: number;
  abstract readonly basis: ReadonlyArray<'geometry' | 'semantics' | 'ocr'>;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  detect(_ctx: DetectorContext): Finding[] {
    return []; // Phase 1: shadow stub — no behaviour, emits nothing, applies nothing.
  }
}

/**
 * 1 — content numerals promoted to question markers. PHASE 2: real behavior (the only ACTIVE
 * detector). It catches the residual class the FROZEN engine guard misses — a SIGN/DASH-prefixed
 * unit (`−22Gm`, `—85eV`) or a locant — because the engine tests the raw token, which begins with
 * the sign. A draft is a phantom when its OWN crop opens with such a content numeral whose value
 * equals the draft's question number AND no separate clean `<n>.` marker exists in the crop (so a
 * real question whose stem merely starts with a formula like `4MgL 11.` is NOT touched: there the
 * value ≠ the question number). Tiering keeps auto-fix tight:
 *   - sign-unit / locant + value==n + no separate marker → HIGH (auto-remove)
 *   - plain unit (no sign) + value==n + no separate marker → MEDIUM (review, never auto-removed,
 *     because a real "5g of …" question numbered 5 is indistinguishable without a human)
 *   - anything else → LOW (NO-OP)
 * Pattern-based, value-free; explainable via semantics + OCR output.
 */
const SIGN_UNIT_RE = /^[-—–]\d{1,3}[A-Za-z]{1,3}(?![A-Za-z])/; // −22Gm  —85eV
const LOCANT_RE = /^[-—–]?\d{1,3}[,\-]\d/; //  2,3   3-4   −5,6
const PLAIN_UNIT_RE = /^\d{1,3}[A-Za-z]{1,3}(?![A-Za-z])/; //  70S  15g  (engine usually catches these)
const leadOf = (s: string): string => (s ?? '').replace(/^["'`|(\s]+/, '');

export class ContentNumeralDetector extends ShadowDetector {
  readonly name = 'content-numerals';
  readonly order = 1;
  readonly basis = ['semantics', 'ocr'] as const;

  detect(ctx: DetectorContext): Finding[] {
    const out: Finding[] = [];
    for (const d of ctx.drafts) {
      const lead = leadOf(d.text);
      const shape: 'sign-unit' | 'locant' | 'unit' | null = SIGN_UNIT_RE.test(lead)
        ? 'sign-unit'
        : LOCANT_RE.test(lead)
          ? 'locant'
          : PLAIN_UNIT_RE.test(lead)
            ? 'unit'
            : null;
      if (!shape) continue;
      const vm = lead.match(/\d{1,3}/);
      const value = vm ? +vm[0] : null;
      const n = d.questionNumber;
      const matchesNumber = value !== null && n !== null && value === n;
      // a separate clean "<n>." marker elsewhere in the crop ⇒ the leading numeral is NOT the marker
      const separateRealMarker =
        n !== null && new RegExp('(?:^|\\s)0*' + n + '[.):;,]').test(' ' + d.text.replace(lead.slice(0, 12), ''));
      if (!matchesNumber || separateRealMarker) continue; // real question whose stem starts with a formula

      const confidence = shape === 'sign-unit' || shape === 'locant' ? 0.9 : 0.7; // HIGH vs MEDIUM
      out.push({
        detector: this.name,
        kind: `${shape}-as-marker`,
        target: { page: ctx.features.pageIndex, draftIndex: d.index, bbox: d.coords },
        confidence,
        evidence: { leadingToken: lead.slice(0, 12), shape, value, questionNumber: n },
        proposedCorrection: 'REMOVE_DRAFT',
      });
    }
    return out;
  }
}

/**
 * 2 — duplicate numbering. PHASE 3: real PAPER-LEVEL behavior. Groups drafts by question number;
 * a group whose instances are ALL well-formed is a LEGITIMATE SECTION RESTART (multi-subject
 * paper) — NOT a failure, no finding. A group with a degenerate instance (and a well-formed
 * sibling) yields a finding for the degenerate one only — so a unique real question is NEVER
 * flagged, and the well-formed sibling always survives:
 *   - short stub (<25 alpha) → real-fragment, HIGH (auto-remove)
 *   - a DIFFERENT clean "<m>." inside the crop → ocr-mislabel, HIGH (auto-remove)
 *   - substantial text but not starting with its own number → real-fragment, MEDIUM (review)
 * Content-numeral-shaped instances are skipped (Detector 1's territory) to avoid double-handling.
 * Cross-instance comparison only; never judges by the number alone. Explainable via semantics+OCR.
 */
const lead2 = (s: string): string => (s ?? '').replace(/^["'`|.,;:_\s]+/, '');
const alphaN = (s: string): number => (s.match(/[A-Za-z]/g) ?? []).length;
const CONTENT_START = /^[-—–]?\d{1,3}(?:[,\-]\d|[A-Za-z]{1,3}(?![A-Za-z]))/;
const firstCleanInner = (s: string): number | null => {
  const m = s.match(/(\d{1,3})\.(?=\s|[A-Z])/);
  return m ? +m[1] : null;
};
const startsWithNumber = (s: string, n: number): boolean => {
  const m = lead2(s).match(new RegExp('(?<![0-9])0*' + n + '[.):;,]'));
  return !!m && (m.index ?? 99) <= 14;
};
const isWellFormedInstance = (text: string, n: number): boolean => {
  if (alphaN(text) < 25 || !startsWithNumber(text, n) || CONTENT_START.test(lead2(text))) return false;
  const fq = firstCleanInner(text);
  return fq === null || fq === n;
};

export class DuplicateNumberingDetector extends ShadowDetector {
  readonly name = 'duplicate-numbering';
  readonly order = 2;
  readonly basis = ['semantics', 'ocr'] as const;

  detectPaper(ctx: PaperDetectorContext): Finding[] {
    const groups = new Map<number, ShadowDraft[]>();
    for (const d of ctx.drafts) {
      if (typeof d.questionNumber !== 'number' || d.questionNumber <= 0) continue;
      const g = groups.get(d.questionNumber);
      if (g) g.push(d);
      else groups.set(d.questionNumber, [d]);
    }
    const out: Finding[] = [];
    for (const [n, insts] of groups) {
      if (insts.length < 2) continue;
      const bad = insts.filter((d) => !isWellFormedInstance(d.text, n));
      if (bad.length === 0) continue; // all well-formed ⇒ legitimate section restart (NOT a failure)
      for (const d of bad) {
        if (CONTENT_START.test(lead2(d.text))) continue; // Detector 1's territory
        const a = alphaN(d.text);
        const fq = firstCleanInner(d.text);
        let cls: 'real-fragment' | 'ocr-mislabel';
        let confidence: number;
        if (a < 25) {
          cls = 'real-fragment';
          confidence = 0.9; // HIGH
        } else if (fq !== null && fq !== n) {
          cls = 'ocr-mislabel';
          confidence = 0.9; // HIGH
        } else {
          cls = 'real-fragment';
          confidence = 0.7; // MEDIUM — ambiguous, review
        }
        out.push({
          detector: this.name,
          kind: `duplicate-${cls}`,
          target: { page: d.page, draftIndex: d.index, bbox: d.coords },
          confidence,
          evidence: { questionNumber: n, class: cls, alpha: a, firstInner: fq, instances: insts.length },
          proposedCorrection: 'REMOVE_DRAFT',
        });
      }
    }
    return out;
  }
}

/**
 * 3 — multi-column. PHASE 6: real per-PAGE detection (owns the START stage via MultiColumnStartHook).
 * Emits informational findings only when there's a genuine two-stream signal (clean gutter + markers
 * on BOTH sides + low crossing): a confident true multi-column page → HIGH (observation, the START
 * hook gates on it); a borderline two-stream page → MEDIUM (review). A single-column / divider /
 * grid / gutter-crossing page produces NO finding (markers not on both sides) → clean papers emit
 * nothing. It never removes/creates drafts (proposedCorrection NONE). Geometry, no values.
 */
export class MultiColumnDetector extends ShadowDetector {
  readonly name = 'multi-column';
  readonly order = 3;
  readonly basis = ['geometry'] as const;

  detect(ctx: DetectorContext): Finding[] {
    const dec = detectMultiColumnPage(ctx.features, ctx.drafts);
    if (dec.gutterX === null || dec.confidence < 0.5) return []; // no two-stream signal → NO-OP
    return [
      {
        detector: this.name,
        kind: dec.multiColumn ? 'multi-column-page' : 'possible-multi-column',
        target: { page: ctx.features.pageIndex },
        confidence: dec.confidence,
        evidence: {
          gutterX: dec.gutterX, leftMarkers: dec.leftMarkers, rightMarkers: dec.rightMarkers,
          crossingFraction: dec.crossingFraction, reason: dec.reason,
        },
        proposedCorrection: 'NONE', // detection only; START ownership is via the hook, never removal
      },
    ];
  }
}

/**
 * 4 — wide content. PHASE 7: real per-draft detection (owns the EXPAND stage via
 * WideContentExpandHook). Emits informational findings (proposedCorrection NONE) for regions that
 * are wider than a logical question — match-the-following / diagram / gutter-crossing / large
 * low-text figure. All findings are HIGH (observation); uncertain regions emit nothing (NO-OP).
 * Never removes/creates/splits/merges; geometry+structure only, no values.
 */
export class WideContentDetector extends ShadowDetector {
  readonly name = 'wide-content';
  readonly order = 4;
  readonly basis = ['geometry'] as const;

  detect(ctx: DetectorContext): Finding[] {
    const out: Finding[] = [];
    for (const d of ctx.drafts) {
      const r = classifyWideContentFromShadow(d, ctx.features, ctx.words);
      if (!r.wide) continue; // not wide / uncertain → NO-OP
      out.push({
        detector: this.name,
        kind: `wide:${r.type}`,
        target: { page: d.page, draftIndex: d.index, bbox: d.coords },
        confidence: r.confidence,
        evidence: { type: r.type, reason: r.reason },
        proposedCorrection: 'NONE', // observation + EXPAND hint only; never removes/splits
      });
    }
    return out;
  }
}

/**
 * 5 — split question + options. PHASE 8: real PAPER-LEVEL detection (owns the EXPAND stage via
 * SplitQuestionExpandHook). Finds orphan option regions (option grammar, no marker, no stem) and
 * their candidate stem under the strict 4-rule gate; emits review findings + an EXPAND hint. It
 * NEVER merges (that would change counts — deferred); the EXPAND hook is NO-OP. Value-free.
 */
export class SplitQuestionOptionsDetector extends ShadowDetector {
  readonly name = 'split-question-options';
  readonly order = 5;
  readonly basis = ['geometry', 'semantics'] as const;

  detectPaper(ctx: PaperDetectorContext): Finding[] {
    return detectSplitOrphans(ctx);
  }
}

/**
 * 6 — cross-page continuation. PHASE 9: real PAPER-LEVEL detection (owns the EXPAND stage via
 * CrossPageExpandHook). Inspects each adjacent page pair: page N's bottom region incomplete +
 * page N+1's top region marker-free + option/continuation text ⇒ continuation candidate (review).
 * NEVER stitches (changes counts — deferred); the EXPAND hook is NO-OP. Value-free.
 */
export class CrossPageContinuationDetector extends ShadowDetector {
  readonly name = 'cross-page-continuation';
  readonly order = 6;
  readonly basis = ['geometry', 'semantics'] as const;

  detectPaper(ctx: PaperDetectorContext): Finding[] {
    return detectCrossPageContinuations(ctx);
  }
}

/**
 * 7 — handwritten markers. PHASE 10: real per-PAGE detection (owns the START stage via
 * HandwrittenStartHook). Flags regions with NO printed marker that nevertheless have a stem + an
 * option block + question-like rhythm — a valid boundary whose number is handwritten/absent. Numbers
 * are HINTS: it routes the uncertainty to review and NEVER creates a question; the START hook is
 * NO-OP. Value-free.
 */
export class HandwrittenMarkerDetector extends ShadowDetector {
  readonly name = 'handwritten-markers';
  readonly order = 7;
  readonly basis = ['geometry', 'ocr'] as const;

  detect(ctx: DetectorContext): Finding[] {
    return detectHandwrittenMarkers(ctx);
  }
}

/**
 * 8 — explanation blocks. PHASE 11: real per-PAGE detection (owns the FINALIZE stage via
 * ExplanationFinalizeHook). Finds an explanation/solution onset BELOW a complete option block and
 * emits a HIGH observation + FINALIZE hint (trim-to-boundary). NEVER trims in Phase 11 (the FINALIZE
 * hook is NO-OP); descriptive/diagram/match are protected (no complete option block / match ⇒ skip).
 * Value-free (OCR structure + completion boundary + generic semantic onset).
 */
export class ExplanationBlockDetector extends ShadowDetector {
  readonly name = 'explanation-blocks';
  readonly order = 8;
  readonly basis = ['semantics', 'geometry'] as const;

  detect(ctx: DetectorContext): Finding[] {
    return detectExplanationBlocks(ctx);
  }
}

/** The frozen detector set, in run order (content → duplicate → multi-column → wide → split →
 *  cross-page → handwritten → explanation). */
export const buildDetectors = (): Detector[] =>
  [
    new ContentNumeralDetector(),
    new DuplicateNumberingDetector(),
    new MultiColumnDetector(),
    new WideContentDetector(),
    new SplitQuestionOptionsDetector(),
    new CrossPageContinuationDetector(),
    new HandwrittenMarkerDetector(),
    new ExplanationBlockDetector(),
  ].sort((a, b) => a.order - b.order);

export const DETECTORS = Symbol('OCR_SHADOW_DETECTORS');
