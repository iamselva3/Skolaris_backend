import { Injectable } from '@nestjs/common';
import { classifyBlock, detectQuestionPunct, isCompleteBlock, medianHeight } from '../../shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../../shared/ocr-engine/column-reorder';
import { BBox, DetectorContext, FinalizeHook, Finding, ShadowDraft, ShadowWord } from './contracts';

/**
 * EXPLANATION BLOCKS detection + FINALIZE hook (Phase 11). Detector #8 (last). It answers ONE
 * question — "where does the logical question end?" — by locating an explanation/solution onset
 * BELOW a complete option block. It owns ONLY the FINALIZE stage.
 *
 * Phase 11 does NOT trim (changing a crop boundary is deferred). It DETECTS, CLASSIFIES, EMITS
 * findings + a FINALIZE hint (trim-to-boundary), and the FINALIZE hook is NO-OP. Value-free: OCR
 * structure + completion boundary + option-block completion + a GENERIC semantic onset pattern
 * (Sol/Ans/Explanation/Hint — not a PDF/institute/exam value) + region ordering.
 *
 * A boundary may end only if ALL hold:
 *   1. a question completion boundary exists (bottom of the option block),
 *   2. the option block is complete (≥2 option labels + isCompleteBlock),
 *   3. an explanation onset appears AFTER the last option,
 *   4. the onset is outside the logical question (below the boundary).
 * Uncertain → NO-OP, never trim aggressively. Descriptive/diagram/table/match/shared-stem are
 * protected: no complete option block (or match-the-following) ⇒ rule 1/2 fails.
 */
const OPTION_LABEL = /^\(?([A-Da-d])[.)]$|^\(([1-4])\)$/;
// generic explanation/solution onset token (semantic pattern, not a value)
const EXPLANATION_ONSET = /^(sol|soln|solution|ans|answer|explanation|explanations|exp|hint|hints)\b[:.)\]]?$/i;
const toBox = (w: ShadowWord): OcrWordBox => ({ text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 });

export const detectExplanationBlocks = (ctx: DetectorContext): Finding[] => {
  const pageWords = ctx.words.map(toBox);
  if (pageWords.length === 0) return [];
  const medH = medianHeight(pageWords);
  const qPunct = detectQuestionPunct(pageWords, medH);
  const out: Finding[] = [];

  for (const d of ctx.drafts) {
    const c = d.coords;
    if (!c) continue;
    const rw = pageWords.filter((w) => {
      const cx = (w.x0 + w.x1) / 2;
      const cy = (w.y0 + w.y1) / 2;
      return cx >= c.x0 && cx < c.x1 && cy >= c.y0 && cy < c.y1;
    });
    if (classifyBlock(rw, qPunct) === 'MATCH_THE_FOLLOWING') continue; // protect match
    const optionYs = rw.filter((w) => OPTION_LABEL.test(w.text)).map((w) => w.y1);
    if (optionYs.length < 2) continue; // rule 1+2: need a complete option block (protects descriptive/diagram)
    if (!isCompleteBlock(rw, qPunct)) continue;
    const completeAtY = Math.max(...optionYs); // completion boundary = bottom of the last option line

    // rule 3+4: an explanation onset, at a line start, BELOW the boundary (outside the question)
    const onset = rw.find((w) => w.y0 > completeAtY + medH * 0.3 && EXPLANATION_ONSET.test(w.text));
    if (!onset) continue;

    out.push({
      detector: 'explanation-blocks',
      kind: 'explanation-after-options',
      target: { page: d.page, draftIndex: d.index, bbox: c },
      confidence: 0.86, // HIGH observation + FINALIZE hint (trim-to-boundary)
      // trim point is the explanation ONSET (top of the explanation), so all options above are kept
      evidence: { completeAtY, onsetY: onset.y0, onsetText: onset.text, trimToY: onset.y0 },
      proposedCorrection: 'NONE',
    });
  }
  return out;
};

/**
 * FINALIZE-stage hook. Phase 11 does NOT trim — it returns the region UNCHANGED (NO-OP). The
 * trim-to-boundary hint lives in the findings; applying it (ending the crop at the completion
 * boundary, above the explanation) is a later, separately-authorized step. `boundaryY` is the
 * Session-3 completion boundary carried through the lifecycle.
 */
@Injectable()
export class ExplanationFinalizeHook implements FinalizeHook {
  readonly name = 'explanation-blocks';

  adjustFinalize(_draft: ShadowDraft, region: BBox, _boundaryY: number | null): BBox {
    return region; // never trim in Phase 11 — NO-OP, safe
  }
}
