import { Injectable } from '@nestjs/common';
import { detectQuestionPunct, hasStem, medianHeight } from '../../shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../../shared/ocr-engine/column-reorder';
import { BBox, ExpandHook, Finding, PaperDetectorContext, ShadowDraft, ShadowWord } from './contracts';

/**
 * SPLIT QUESTION + OPTIONS detection + EXPAND hook (Phase 8). Detector #5. It answers ONE question —
 * "do these two regions belong to the same logical question?" — by finding ORPHAN OPTION REGIONS
 * (an option-grammar region with NO question marker and NO stem) and, under a strict gate, their
 * candidate stem. It owns ONLY the EXPAND stage.
 *
 * Phase 8 does NOT merge (merging changes counts — not allowed here). It DETECTS, CLASSIFIES, EMITS
 * findings + an EXPAND hint, and routes uncertainty to review. The EXPAND hook is NO-OP. Value-free:
 * geometry + region proximity + option grammar + marker presence + the engine's read-only hasStem.
 *
 * Association gate — a candidate option region may belong to a stem only if ALL hold:
 *   1. no valid next question marker exists between them,
 *   2. the candidate (orphan) region has no question marker,
 *   3. the candidate (orphan) region has no stem,
 *   4. the neighbouring option area is marker-free.
 * Never merge when uncertain → NO-OP. Protects true multi-column / match / diagrams / shared stems
 * implicitly: those regions carry markers and/or stems, so they are never orphans.
 */
const OPTION_LABEL = /^\(?([A-Da-d])[.)]$|^\(([1-4])\)$/;
const toBox = (w: ShadowWord): OcrWordBox => ({ text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 });
const xOverlap = (a: BBox, b: BBox): boolean => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0;
const yOverlapFrac = (a: BBox, b: BBox): number => {
  const o = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return o <= 0 ? 0 : o / Math.max(1, Math.min(a.y1 - a.y0, b.y1 - b.y0));
};
const optionLabelCount = (rw: OcrWordBox[]): number => {
  const s = new Set<string>();
  for (const w of rw) { const m = w.text.match(OPTION_LABEL); if (m) s.add((m[1] ?? m[2]).toLowerCase()); }
  return s.size;
};

/** Paper-level orphan detection + candidate-stem association. Returns review findings (never merges). */
export const detectSplitOrphans = (ctx: PaperDetectorContext): Finding[] => {
  const out: Finding[] = [];
  const pages = new Map<number, ShadowDraft[]>();
  for (const d of ctx.drafts) {
    const g = pages.get(d.page);
    if (g) g.push(d);
    else pages.set(d.page, [d]);
  }

  for (const [page, pageDrafts] of pages) {
    const words = (ctx.wordsByPage[page - 1] ?? []).map(toBox);
    if (words.length === 0) continue;
    const qPunct = detectQuestionPunct(words, medianHeight(words));
    const sorted = [...pageDrafts].sort((a, b) => (a.coords?.y0 ?? 0) - (b.coords?.y0 ?? 0));

    const rwOf = (b: { x0: number; y0: number; x1: number; y1: number }) =>
      words.filter((w) => { const cx = (w.x0 + w.x1) / 2; const cy = (w.y0 + w.y1) / 2; return cx >= b.x0 && cx < b.x1 && cy >= b.y0 && cy < b.y1; });

    for (const d of sorted) {
      const c = d.coords;
      if (!c) continue;
      const rw = rwOf(c);
      // ROOT-CAUSE FIX: an orphan OPTION BLOCK is identified STRUCTURALLY — ≥2 option labels and NO
      // stem — regardless of any (mis-read, marker-driven) questionNumber the engine assigned. The
      // old `questionNumber === null` gate could never match a real engine-produced split region.
      if (optionLabelCount(rw) < 2 || hasStem(rw, qPunct)) continue;

      // candidate stem = a region that HAS a stem but is MISSING its options, adjacent EITHER
      //   vertically (above, x-overlapping)  → top/bottom split, OR
      //   horizontally (either side, sharing the row-band) → left/right COLUMN split.
      let vertical: ShadowDraft | null = null;
      let horizontal: ShadowDraft | null = null;
      for (const s of sorted) {
        if (s === d || !s.coords) continue;
        const srw = rwOf(s.coords);
        if (!hasStem(srw, qPunct) || optionLabelCount(srw) >= 2) continue; // a stem MISSING its options
        if (s.coords.y0 < c.y0 && xOverlap(s.coords, c)) vertical = s; // nearest above (sorted by y)
        // horizontal: a stem sharing the row-band on EITHER side of the options (stem-left/options-
        // right = CASE 1, OR options-left/stem-right = CASE 2). Direction-agnostic, no value coupling.
        else if (
          (s.coords.x1 <= c.x0 + 20 || s.coords.x0 >= c.x1 - 20) &&
          yOverlapFrac(s.coords, c) > 0.3 &&
          !horizontal
        ) horizontal = s;
      }
      const candidate = vertical ?? horizontal;
      const mode = vertical ? 'vertical' : horizontal ? 'horizontal' : 'none';

      // SAFETY GATES: (a) the orphan must NOT itself be a valid next sequential question;
      // (b) no valid question marker sits between a vertical candidate and the orphan;
      // (c) a MARKER-FREE PATH must exist — for a horizontal (column) split the ENTIRE orphan column
      //     must carry no question markers (the AD true-2-column trap: a real second column owns its
      //     markers, so any marker x-overlapping the orphan ⇒ NOT a split ⇒ refuse the merge → review).
      const dIsValidNext =
        !!candidate && typeof d.questionNumber === 'number' && typeof candidate.questionNumber === 'number' &&
        d.questionNumber === candidate.questionNumber + 1;
      const markerBetween =
        !!candidate && mode === 'vertical' &&
        sorted.some((m) => m !== d && m !== candidate && typeof m.questionNumber === 'number' && m.coords &&
          m.coords.y0 > candidate.coords!.y0 && m.coords.y0 < c.y0 && xOverlap(m.coords, c));
      const markerFreePath =
        !candidate
          ? false
          : mode === 'vertical'
            ? !markerBetween
            : !sorted.some((m) => m !== d && m !== candidate && typeof m.questionNumber === 'number' && m.coords && xOverlap(m.coords, c));
      // The structural signals candidate + not-valid-next + marker-free-path are necessary but NOT
      // sufficient. PROVEN UNSAFE: on the RE NEET regression standard they merged Q142's stem with the
      // ENTIRE Q148 Assertion-Reason question in the adjacent column (markerFreePath was true only
      // because Q143-147 live in the OTHER column, so no marker x-overlapped the gap) → a FALSE MERGE
      // that lost a real question (180→179). With 0 validated positive samples a merge can NEVER be
      // proven safe on unseen layouts. SAFE FALLBACK: NEVER auto-merge — every orphan is unresolved →
      // the Delivery layer BLOCKS the PDF to review (never a silent pass, never a false merge).
      const provable = !!candidate && !dIsValidNext && markerFreePath; // review detail only — NOT applied
      const associable = false as boolean; // auto-merge disabled (see above)
      out.push({
        detector: 'split-question-options',
        kind: associable ? 'split-orphan-associable' : 'split-orphan-unresolved',
        target: { page, draftIndex: d.index, bbox: c },
        confidence: 0.7, // unresolved ⇒ delivery blocker → review (never silent, never auto-merged)
        evidence: { orphanDraft: d.index, candidateStem: candidate?.index ?? null, mode, dIsValidNext, markerBetween, markerFreePath, provable },
        proposedCorrection: 'NONE',
      });
    }
  }
  return out;
};

/**
 * EXPAND-stage hook. Phase 8 does NOT merge (merging changes counts — not allowed), so the hook
 * returns the region UNCHANGED (NO-OP). The merge hint lives in the findings/review queue; applying
 * it (associating an orphan into its stem) is a later, separately-authorized step.
 */
@Injectable()
export class SplitQuestionExpandHook implements ExpandHook {
  readonly name = 'split-question-options';

  adjustExpand(_draft: ShadowDraft, region: BBox, _ctx: PaperDetectorContext): BBox {
    return region; // never merge / grow / shrink in Phase 8 — NO-OP, safe
  }
}
