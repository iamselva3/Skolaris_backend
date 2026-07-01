import { Injectable } from '@nestjs/common';
import { BBox, PageFeatures, PaperDetectorContext, ShadowDraft, StartHook } from './contracts';

/**
 * MULTI-COLUMN detection + START hook (Phase 6). Detector #3. It owns ONLY the START lifecycle
 * stage; it never touches EXPAND/COMPLETE/FINALIZE/EMIT, never splits, never reflows.
 *
 * A page is TRUE multi-column ONLY if ALL hold (value-free, geometry+markers):
 *   1. independent marker streams — ≥2 question markers on EACH side, each side increasing;
 *   2. a valid whitespace gutter — a clean vertical river (high cleanFraction);
 *   3. both sides contain markers;
 *   4. independently readable — content does NOT cross the gutter (low crossing).
 * Anything crossing the gutter (diagram/table/graph/circuit/figure/match/shared-stem) keeps the page
 * out of multi-column → kept full width. Low confidence → NO-OP. Per-PAGE: different pages may differ.
 */
const MIN_GUTTER_CLEAN = 0.8;
const MAX_CROSSING = 0.15;
const MULTI_COLUMN_CONF = 0.85;

export interface MultiColumnDecision {
  multiColumn: boolean;
  confidence: number;
  gutterX: number | null;
  columns: Array<{ left: number; right: number }>;
  leftMarkers: number;
  rightMarkers: number;
  crossingFraction: number;
  reason: string;
}

const centerX = (b: BBox): number => (b.x0 + b.x1) / 2;
const increasing = (drafts: ReadonlyArray<ShadowDraft>): boolean => {
  const ns = drafts.map((d) => d.questionNumber).filter((n): n is number => typeof n === 'number');
  if (ns.length < 2) return false;
  let up = 0;
  for (let i = 1; i < ns.length; i += 1) if (ns[i] > ns[i - 1]) up += 1;
  return up >= ns.length - 2; // tolerate ≤1 out-of-order (OCR jitter)
};

/** Pure, value-free multi-column decision for one page. */
export const detectMultiColumnPage = (f: PageFeatures, pageDrafts: ReadonlyArray<ShadowDraft>): MultiColumnDecision => {
  const none = (reason: string): MultiColumnDecision => ({
    multiColumn: false, confidence: 0, gutterX: null, columns: [], leftMarkers: 0, rightMarkers: 0, crossingFraction: 0, reason,
  });
  const g = f.gutters.find((x) => x.cleanFraction >= MIN_GUTTER_CLEAN);
  if (!g) return none('no clean whitespace gutter');
  const withCoords = pageDrafts.filter((d) => d.coords) as Array<ShadowDraft & { coords: BBox }>;
  if (withCoords.length < 4) return none('too few markers');

  const pad = Math.round(f.width * 0.01);
  const left = withCoords.filter((d) => centerX(d.coords) < g.x);
  const right = withCoords.filter((d) => centerX(d.coords) >= g.x);
  if (left.length < 2 || right.length < 2) return none('markers not present on both sides (single stream)');

  const crossing = withCoords.filter((d) => d.coords.x0 < g.x - pad && d.coords.x1 > g.x + pad);
  const crossingFraction = crossing.length / withCoords.length;
  if (crossingFraction > MAX_CROSSING) return none(`content crosses the gutter (${crossingFraction.toFixed(2)}) — keep full width`);

  const indep = increasing(left) && increasing(right);
  const balance = Math.min(left.length, right.length) / Math.max(left.length, right.length);
  const confidence = Math.max(0, Math.min(1, g.cleanFraction * 0.5 + balance * 0.3 + (indep ? 0.2 : 0)));
  const minLeft = Math.min(...withCoords.map((d) => d.coords.x0));
  return {
    multiColumn: indep && confidence >= MULTI_COLUMN_CONF,
    confidence: Math.round(confidence * 100) / 100,
    gutterX: g.x,
    columns: [{ left: minLeft, right: g.x }, { left: g.x, right: f.width }],
    leftMarkers: left.length,
    rightMarkers: right.length,
    crossingFraction: Math.round(crossingFraction * 100) / 100,
    reason: indep && confidence >= MULTI_COLUMN_CONF
      ? `true multi-column conf=${confidence.toFixed(2)} L=${left.length} R=${right.length} cross=${crossingFraction.toFixed(2)}`
      : `not confident multi-column (conf=${confidence.toFixed(2)}, indep=${indep})`,
  };
};

/**
 * START-stage hook. On a CONFIDENT multi-column page it confirms the question's column membership.
 * It returns the region UNCHANGED (NO-OP geometry): the frozen engine already column-scopes drafts,
 * and any clamp would risk cutting content that legitimately reaches the gutter, while splitting a
 * gutter-spanning draft is forbidden here (that is EXPAND/Split's job). So this hook owns the START
 * decision and gates on multi-column, but applies no unsafe geometry change — prefer NO-OP. A future
 * phase (when the framework drives segmentation) may override the start position here.
 */
@Injectable()
export class MultiColumnStartHook implements StartHook {
  readonly name = 'multi-column';

  adjustStart(draft: ShadowDraft, region: BBox, ctx: PaperDetectorContext): BBox {
    const f = ctx.pages.find((p) => p.pageIndex === draft.page);
    if (!f) return region;
    const pageDrafts = ctx.drafts.filter((d) => d.page === draft.page);
    const dec = detectMultiColumnPage(f, pageDrafts);
    if (!dec.multiColumn || dec.gutterX === null) return region; // not confident multi-column → NO-OP
    const cx = centerX(region);
    const inColumn = dec.columns.some((c) => cx >= c.left && cx < c.right);
    const spansGutter = region.x0 < dec.gutterX && region.x1 > dec.gutterX;
    if (!inColumn || spansGutter) return region; // can't safely adjust / must not split → NO-OP
    return region; // column-confirmed; geometry unchanged (engine already column-scoped) — NO-OP, safe
  }
}
