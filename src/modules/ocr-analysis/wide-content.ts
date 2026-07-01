import { Injectable } from '@nestjs/common';
import { classifyBlock, detectQuestionPunct, medianHeight } from '../../shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../../shared/ocr-engine/column-reorder';
import { BBox, ExpandHook, PageFeatures, PaperDetectorContext, ShadowDraft, ShadowWord } from './contracts';

/**
 * WIDE CONTENT detection + EXPAND hook (Phase 7). Detector #4. It answers ONE question — "is this
 * content wider than a logical question?" — and owns ONLY the EXPAND lifecycle stage. It never
 * touches START/COMPLETE/FINALIZE/EMIT, never creates/deletes/splits/merges questions, never emits
 * crops, never changes counts or boundaries.
 *
 * Value-free signals only (geometry + whitespace + text density + gutter crossing + the engine's
 * read-only classifyBlock): a region is WIDE CONTENT when it is a match-the-following / matrix, a
 * diagram/graph/circuit block, a large low-text figure/image region, or it CROSSES a whitespace
 * gutter. Wide content is KEPT FULL WIDTH and must not be split. Uncertain → NO-OP (no finding).
 */
const MIN_GUTTER_CLEAN = 0.6;
const toBox = (w: ShadowWord): OcrWordBox => ({ text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 });
const inRegion = (w: OcrWordBox, c: BBox): boolean => {
  const cx = (w.x0 + w.x1) / 2;
  const cy = (w.y0 + w.y1) / 2;
  return cx >= c.x0 && cx < c.x1 && cy >= c.y0 && cy < c.y1;
};

export type WideContentType = 'match-the-following' | 'diagram' | 'crosses-gutter' | 'low-density-figure';

export interface WideContentDecision {
  wide: boolean;
  type: WideContentType | null;
  confidence: number;
  reason: string;
}

/** Pure, value-free wide-content decision for one draft region. */
export const classifyWideContent = (
  draft: ShadowDraft,
  f: PageFeatures,
  pageWords: OcrWordBox[],
  qPunct: ')' | '.',
): WideContentDecision => {
  const c = draft.coords;
  if (!c) return { wide: false, type: null, confidence: 0, reason: 'no coords' };
  const rw = pageWords.filter((w) => inRegion(w, c));
  const cls = classifyBlock(rw, qPunct);
  const pad = Math.round(f.width * 0.01);
  const g = f.gutters[0]; // highest cleanFraction
  const crosses = !!g && g.cleanFraction >= MIN_GUTTER_CLEAN && c.x0 < g.x - pad && c.x1 > g.x + pad;
  const areaFrac = ((c.x1 - c.x0) * (c.y1 - c.y0)) / Math.max(1, f.width * f.height);
  const sparse = rw.length <= 6 && areaFrac >= 0.08; // large region, very little text → figure/image

  let type: WideContentType | null = null;
  let confidence = 0;
  if (cls === 'MATCH_THE_FOLLOWING') {
    type = 'match-the-following';
    confidence = 0.9;
  } else if (cls === 'DIAGRAM_BASED') {
    type = 'diagram';
    confidence = 0.88;
  } else if (crosses) {
    type = 'crosses-gutter';
    confidence = 0.9;
  } else if (sparse) {
    type = 'low-density-figure';
    confidence = 0.86;
  }
  return {
    wide: type !== null,
    type,
    confidence,
    reason: type ? `${type} (cls=${cls}, areaFrac=${areaFrac.toFixed(2)}, words=${rw.length})` : 'not wider than a logical question',
  };
};

export const classifyWideContentFromShadow = (
  draft: ShadowDraft,
  f: PageFeatures,
  words: ReadonlyArray<ShadowWord>,
): WideContentDecision => {
  const pageWords = words.map(toBox);
  const qPunct = detectQuestionPunct(pageWords, medianHeight(pageWords));
  return classifyWideContent(draft, f, pageWords, qPunct);
};

/**
 * EXPAND-stage hook. Wide content is KEPT FULL WIDTH: the hook returns the region UNCHANGED. In
 * Phase 7 nothing narrows or splits a region, so the only safe action is NO-OP — wide content
 * stays exactly as the (frozen) engine produced it. The hook owns EXPAND and records the
 * keep-full-width intent; it never grows or shrinks geometry, never splits, never merges.
 */
@Injectable()
export class WideContentExpandHook implements ExpandHook {
  readonly name = 'wide-content';

  adjustExpand(_draft: ShadowDraft, region: BBox, _ctx: PaperDetectorContext): BBox {
    return region; // keep full width; never split/grow/shrink — NO-OP, safe
  }
}
