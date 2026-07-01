import { Injectable } from '@nestjs/common';
import { detectQuestionPunct, hasStem, medianHeight } from '../../shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../../shared/ocr-engine/column-reorder';
import { BBox, DetectorContext, Finding, PaperDetectorContext, ShadowDraft, ShadowWord, StartHook } from './contracts';

/**
 * HANDWRITTEN MARKERS detection + START hook (Phase 10). Detector #7. It answers ONE question —
 * "can a valid logical question boundary exist WITHOUT a printed question marker?" — for regions
 * where the printed number is weak/absent (pen/pencil/circled/stamped/margin numbers OCR can't read).
 * It owns ONLY the START stage.
 *
 * Numbers are HINTS, never mandatory: a candidate is a region with NO printed marker that
 * nevertheless has a real stem + a real option block + a question-like vertical rhythm. It does NOT
 * create a question (the region already exists as a draft) — it confirms the boundary is valid and
 * routes the uncertainty (the missing number) to review. The START hook is NO-OP. Value-free:
 * geometry + OCR structure + marker absence + option-block presence + spacing rhythm.
 *
 * Candidate only if ALL hold:
 *   1. printed marker weak/absent (questionNumber === null),
 *   2. a valid stem region exists (read-only hasStem),
 *   3. a valid option block exists (≥2 distinct option labels),
 *   4. vertical rhythm resembles a logical question (height near the page's median question height).
 * Uncertain → NO-OP. Diagrams/tables/match/shared-stems are protected: no option block ⇒ rule 3 fails.
 */
const OPTION_LABEL = /^\(?([A-Da-d])[.)]$|^\(([1-4])\)$/;
const toBox = (w: ShadowWord): OcrWordBox => ({ text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 });

const distinctOptionLabels = (words: OcrWordBox[]): number => {
  const set = new Set<string>();
  for (const w of words) {
    const m = w.text.match(OPTION_LABEL);
    if (m) set.add((m[1] ?? m[2]).toLowerCase());
  }
  return set.size;
};

export const detectHandwrittenMarkers = (ctx: DetectorContext): Finding[] => {
  const pageWords = ctx.words.map(toBox);
  if (pageWords.length === 0) return [];
  const qPunct = detectQuestionPunct(pageWords, medianHeight(pageWords));
  const heights = ctx.drafts.map((d) => (d.coords ? d.coords.y1 - d.coords.y0 : 0)).filter((h) => h > 0).sort((a, b) => a - b);
  const medH = heights.length ? heights[Math.floor(heights.length / 2)] : 0;

  const out: Finding[] = [];
  for (const d of ctx.drafts) {
    const c = d.coords;
    if (!c) continue;
    if (d.questionNumber !== null) continue; // rule 1: a printed marker IS present → not a candidate
    const rw = pageWords.filter((w) => {
      const cx = (w.x0 + w.x1) / 2;
      const cy = (w.y0 + w.y1) / 2;
      return cx >= c.x0 && cx < c.x1 && cy >= c.y0 && cy < c.y1;
    });
    if (!hasStem(rw, qPunct)) continue; // rule 2: needs a real stem
    if (distinctOptionLabels(rw) < 2) continue; // rule 3: needs a real option block
    const h = c.y1 - c.y0; // rule 4: question-like vertical rhythm
    if (medH > 0 && (h < medH * 0.5 || h > medH * 2.5)) continue;
    out.push({
      detector: 'handwritten-markers',
      kind: 'unmarked-question-boundary',
      target: { page: d.page, draftIndex: d.index, bbox: c },
      confidence: 0.7, // MEDIUM → review; never auto-create (numbers are hints, not mandatory)
      evidence: { hasStem: true, optionLabels: distinctOptionLabels(rw), heightRatio: medH ? Math.round((h / medH) * 100) / 100 : null },
      proposedCorrection: 'NONE',
    });
  }
  return out;
};

/**
 * START-stage hook. The handwritten-marker candidate is an EXISTING region whose printed number is
 * absent; the hook confirms the boundary but returns geometry UNCHANGED (NO-OP) — it never creates a
 * question or moves a boundary. The review finding carries the uncertainty.
 */
@Injectable()
export class HandwrittenStartHook implements StartHook {
  readonly name = 'handwritten-markers';

  adjustStart(_draft: ShadowDraft, region: BBox, _ctx: PaperDetectorContext): BBox {
    return region; // never create/move — NO-OP, safe
  }
}
