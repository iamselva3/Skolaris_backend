/**
 * Phase B — region-aware figure/table → draft attachment.
 *
 * Replaces the Slice 2.3 Y-stripe heuristic when PP-Structure regions are
 * available. Both algorithms exist in parallel: this function runs when the
 * Paddle response includes `regions[]` AND the engine is invoked with
 * `useRegions: true`; otherwise the legacy proportional-Y attachment runs.
 *
 * Algorithm
 * ─────────
 * Per page:
 *   1. Collect TEXT and TITLE regions in `readingOrder` — these are the
 *      "text blocks" PP-Structure detected on the page.
 *   2. Partition the page's drafts proportionally over those blocks: draft i
 *      (of N) owns text blocks [i·T/N, (i+1)·T/N) of the T blocks. Each
 *      draft's anchored Y range = union of y0/y1 of its owned blocks.
 *   3. For each FIGURE crop on the page, pick the draft with greatest
 *      Y-overlap with the figure's bbox. Ties → smallest centroid distance.
 *   4. Same picking rule for TABLE regions; their `tableHtml` populates
 *      `draft.tableHtml` (first one) + `draft.tables[]` (all of them).
 *
 * Why this beats the Y-stripe heuristic: on dense pages (NEET-style two-
 * column papers with multiple short questions) the stripe is a fraction of
 * page height — figures whose vertical extent crosses a stripe boundary land
 * in the wrong draft. Anchoring to PP-Structure's actual text-region Y
 * positions removes that ambiguity for any page where the layout model fires.
 */
import type { OcrEngineDraft, OcrEngineFigure } from './ocr-engine';
import type { OcrRegion } from './paddle-printed-http';

export interface RegionAttachInput {
  drafts: OcrEngineDraft[];
  /** Figures grouped by pageNumber — already uploaded (storageKey populated). */
  figuresByPage: Map<number, OcrEngineFigure[]>;
  /** All typed regions from the Paddle response (flat, global readingOrder). */
  regions: OcrRegion[];
}

export interface RegionAttachResult {
  figuresAttached: number;
  tablesAttached: number;
  snapshotsAttached: number;
}

const pickByYOverlap = (
  draftYRanges: Array<{ yMin: number; yMax: number; centerY: number }>,
  y0: number,
  y1: number,
): number => {
  const centerY = (y0 + y1) / 2;
  let bestIdx = 0;
  let bestOverlap = -1;
  let bestDist = Infinity;
  for (let i = 0; i < draftYRanges.length; i += 1) {
    const range = draftYRanges[i];
    const overlap = Math.max(0, Math.min(y1, range.yMax) - Math.max(y0, range.yMin));
    const dist = Math.abs(range.centerY - centerY);
    if (overlap > bestOverlap || (overlap === bestOverlap && dist < bestDist)) {
      bestIdx = i;
      bestOverlap = overlap;
      bestDist = dist;
    }
  }
  return bestIdx;
};

export const attachFiguresByRegions = ({
  drafts,
  figuresByPage,
  regions,
}: RegionAttachInput): RegionAttachResult => {
  const textRegionsByPage = new Map<number, OcrRegion[]>();
  const tableRegionsByPage = new Map<number, OcrRegion[]>();
  for (const r of regions) {
    if (r.type === 'TEXT' || r.type === 'TITLE') {
      const arr = textRegionsByPage.get(r.pageNumber) ?? [];
      arr.push(r);
      textRegionsByPage.set(r.pageNumber, arr);
    } else if (r.type === 'TABLE') {
      const arr = tableRegionsByPage.get(r.pageNumber) ?? [];
      arr.push(r);
      tableRegionsByPage.set(r.pageNumber, arr);
    }
  }
  for (const arr of textRegionsByPage.values()) {
    arr.sort((a, b) => a.readingOrder - b.readingOrder);
  }

  const draftsByPage = new Map<number, OcrEngineDraft[]>();
  for (const d of drafts) {
    if (d.sourcePageNumber === undefined) continue;
    const arr = draftsByPage.get(d.sourcePageNumber) ?? [];
    arr.push(d);
    draftsByPage.set(d.sourcePageNumber, arr);
  }

  let figuresAttached = 0;
  let tablesAttached = 0;
  let snapshotsAttached = 0;

  for (const [pageNum, pageDrafts] of draftsByPage) {
    if (pageDrafts.length === 0) continue;
    const textRegions = textRegionsByPage.get(pageNum) ?? [];

    const N = pageDrafts.length;
    const T = textRegions.length;
    const draftYRanges: Array<{ yMin: number; yMax: number; centerY: number }> = [];

    if (T === 0) {
      // No text regions on this page — fall back to "whole page" for every
      // draft. Effectively a no-op selector that still lets figures attach,
      // but they all collapse onto draft 0 which is acceptable for a page
      // with no PP-Structure text detection (likely cover/image-only).
      for (let i = 0; i < N; i += 1) {
        draftYRanges.push({
          yMin: 0,
          yMax: Number.MAX_SAFE_INTEGER,
          centerY: Number.MAX_SAFE_INTEGER / 2,
        });
      }
    } else {
      for (let i = 0; i < N; i += 1) {
        const lo = Math.floor((i * T) / N);
        const hi = Math.max(lo + 1, Math.floor(((i + 1) * T) / N));
        const owned = textRegions.slice(lo, Math.min(hi, T));
        if (owned.length === 0) {
          draftYRanges.push({ yMin: 0, yMax: 0, centerY: 0 });
          continue;
        }
        const yMin = Math.min(...owned.map((r) => r.bbox.y0));
        const yMax = Math.max(...owned.map((r) => r.bbox.y1));
        draftYRanges.push({ yMin, yMax, centerY: (yMin + yMax) / 2 });
      }
    }

    const snapshots = regions.filter(
      (r) =>
        r.pageNumber === pageNum &&
        r.type === 'FIGURE' &&
        (r.metadata as Record<string, unknown> | undefined)?.role === 'question_snapshot' &&
        r.storageKey,
    );
    for (const snap of snapshots) {
      const idx = pickByYOverlap(draftYRanges, snap.bbox.y0, snap.bbox.y1);
      const target = pageDrafts[idx];
      if (!target.questionSnapshotKey && snap.storageKey) {
        target.questionSnapshotKey = snap.storageKey;
        target.needsImageReview = true;
        snapshotsAttached += 1;
      }
    }
    const snapshotKeys = new Set(snapshots.map((s) => s.storageKey));

    const pageFigs = figuresByPage.get(pageNum) ?? [];
    for (const fig of pageFigs) {
      if (snapshotKeys.has(fig.storageKey)) continue;
      const idx = pickByYOverlap(draftYRanges, fig.boundingBox.y0, fig.boundingBox.y1);
      const target = pageDrafts[idx];
      if (!target.figures) target.figures = [];
      target.figures.push({
        storageKey: fig.storageKey,
        kind: fig.kind,
        boundingBox: fig.boundingBox,
        caption: fig.caption,
      });
      figuresAttached += 1;
    }

    const pageTables = tableRegionsByPage.get(pageNum) ?? [];
    for (const tbl of pageTables) {
      if (!tbl.tableHtml) continue;
      const idx = pickByYOverlap(draftYRanges, tbl.bbox.y0, tbl.bbox.y1);
      const target = pageDrafts[idx];
      if (!target.tables) target.tables = [];
      target.tables.push({
        html: tbl.tableHtml,
        storageKey: tbl.storageKey ?? '',
        boundingBox: {
          x0: tbl.bbox.x0,
          y0: tbl.bbox.y0,
          x1: tbl.bbox.x1,
          y1: tbl.bbox.y1,
          page: tbl.pageNumber,
        },
      });
      if (!target.tableHtml) target.tableHtml = tbl.tableHtml;
      tablesAttached += 1;
    }
  }

  return { figuresAttached, tablesAttached, snapshotsAttached };
};
