/**
 * Phase B — spatial attacher unit tests. Locks in the behavior that:
 *   1. Figures attach to the draft whose owned TEXT regions overlap the
 *      figure's Y range (NOT the proportional-Y stripe a draft would have
 *      been assigned in the legacy heuristic).
 *   2. TABLE regions with HTML populate draft.tableHtml + draft.tables[].
 *   3. Header/footer regions do not affect draft Y-anchoring (only TEXT/TITLE
 *      contribute to the per-draft Y range).
 *
 * No paddleocr / Python / network — pure data-in / data-out.
 */
import { attachFiguresByRegions } from './region-attach';
import type { OcrEngineDraft, OcrEngineFigure } from './ocr-engine';
import type { OcrRegion } from './paddle-printed-http';

const draft = (overrides: Partial<OcrEngineDraft>): OcrEngineDraft => ({
  position: 0,
  text: '',
  detectedType: 'DESCRIPTIVE',
  confidence: 0,
  ...overrides,
});

const textRegion = (
  pageNumber: number,
  readingOrder: number,
  y0: number,
  y1: number,
  content = '',
): OcrRegion => ({
  type: 'TEXT',
  pageNumber,
  bbox: { x0: 50, y0, x1: 800, y1 },
  confidence: 0.95,
  readingOrder,
  content,
  tableHtml: null,
  storageKey: null,
  metadata: {},
});

const tableRegion = (
  pageNumber: number,
  readingOrder: number,
  y0: number,
  y1: number,
  html: string,
): OcrRegion => ({
  type: 'TABLE',
  pageNumber,
  bbox: { x0: 50, y0, x1: 800, y1 },
  confidence: 0.9,
  readingOrder,
  content: null,
  tableHtml: html,
  storageKey: 'r2://t/123.png',
  metadata: {},
});

const figure = (
  pageNumber: number,
  y0: number,
  y1: number,
  storageKey: string,
): OcrEngineFigure & { centerY: number; pageHeight: number } => ({
  storageKey,
  kind: 'figure',
  boundingBox: { x0: 50, y0, x1: 800, y1, page: pageNumber },
  centerY: (y0 + y1) / 2,
  pageHeight: 1200,
});

describe('attachFiguresByRegions', () => {
  it('attaches a figure to the draft whose text-region Y range overlaps it', () => {
    // Page with 2 drafts (top + bottom) and 2 text regions and 1 figure
    // sitting BELOW the first text region. Y-stripe would split the page
    // 50/50 and could attach to either; region-aware picks the right one.
    const drafts: OcrEngineDraft[] = [
      draft({ position: 0, sourcePageNumber: 1, text: 'Q1 stem' }),
      draft({ position: 1, sourcePageNumber: 1, text: 'Q2 stem' }),
    ];
    const regions: OcrRegion[] = [
      textRegion(1, 0, 100, 250), // Q1 lives here
      textRegion(1, 1, 700, 900), // Q2 lives here
    ];
    const figuresByPage = new Map<number, ReturnType<typeof figure>[]>([
      // Figure right below Q1's text — should attach to Q1, not Q2.
      [1, [figure(1, 260, 500, 'r2://fig-1.png')]],
    ]);
    const r = attachFiguresByRegions({ drafts, figuresByPage, regions });
    expect(r.figuresAttached).toBe(1);
    expect(drafts[0].figures?.[0].storageKey).toBe('r2://fig-1.png');
    expect(drafts[1].figures).toBeUndefined();
  });

  it('attaches a figure to the closest draft when no Y range overlaps', () => {
    const drafts: OcrEngineDraft[] = [
      draft({ position: 0, sourcePageNumber: 1, text: 'Q1' }),
      draft({ position: 1, sourcePageNumber: 1, text: 'Q2' }),
    ];
    const regions: OcrRegion[] = [textRegion(1, 0, 100, 200), textRegion(1, 1, 800, 950)];
    const figuresByPage = new Map([
      // Figure sitting in the empty middle band — no overlap with either
      // text region. Picker should pick by smallest centroid distance:
      // figure centerY=575 → Q1 (centerY=150) dist=425, Q2 (centerY=875) dist=300 → Q2.
      [1, [figure(1, 500, 650, 'r2://orphan.png')]],
    ]);
    const r = attachFiguresByRegions({ drafts, figuresByPage, regions });
    expect(r.figuresAttached).toBe(1);
    expect(drafts[1].figures?.[0].storageKey).toBe('r2://orphan.png');
  });

  it('populates tableHtml + tables[] when a TABLE region overlaps a draft', () => {
    const drafts: OcrEngineDraft[] = [
      draft({ position: 0, sourcePageNumber: 1, text: 'Compare:' }),
    ];
    const regions: OcrRegion[] = [
      textRegion(1, 0, 100, 200, 'Compare:'),
      tableRegion(1, 1, 250, 500, '<table><tr><td>x</td></tr></table>'),
    ];
    const figuresByPage = new Map();
    const r = attachFiguresByRegions({ drafts, figuresByPage, regions });
    expect(r.tablesAttached).toBe(1);
    expect(drafts[0].tableHtml).toBe('<table><tr><td>x</td></tr></table>');
    expect(drafts[0].tables?.[0].html).toBe('<table><tr><td>x</td></tr></table>');
    expect(drafts[0].tables?.[0].storageKey).toBe('r2://t/123.png');
  });

  it('ignores HEADER/FOOTER regions when computing draft Y anchors', () => {
    // Two drafts, two text regions, plus a HEADER and FOOTER. If HEADER/FOOTER
    // leaked into the Y-range computation Q1's anchor would be enormous and
    // would swallow figures meant for Q2.
    const drafts: OcrEngineDraft[] = [
      draft({ position: 0, sourcePageNumber: 1 }),
      draft({ position: 1, sourcePageNumber: 1 }),
    ];
    const regions: OcrRegion[] = [
      // HEADER at very top — must be ignored
      {
        type: 'HEADER',
        pageNumber: 1,
        bbox: { x0: 0, y0: 0, x1: 800, y1: 50 },
        confidence: 0.9,
        readingOrder: 0,
        content: 'CC-315',
        tableHtml: null,
        storageKey: null,
        metadata: {},
      },
      textRegion(1, 1, 100, 250), // Q1
      textRegion(1, 2, 700, 900), // Q2
      // FOOTER at very bottom — must be ignored
      {
        type: 'FOOTER',
        pageNumber: 1,
        bbox: { x0: 0, y0: 1150, x1: 800, y1: 1200 },
        confidence: 0.9,
        readingOrder: 3,
        content: 'Page 1/15',
        tableHtml: null,
        storageKey: null,
        metadata: {},
      },
    ];
    const figuresByPage = new Map([
      // Figure sitting in Q2's Y range
      [1, [figure(1, 750, 880, 'r2://q2-fig.png')]],
    ]);
    const r = attachFiguresByRegions({ drafts, figuresByPage, regions });
    expect(r.figuresAttached).toBe(1);
    // Q2 must get it — proves HEADER/FOOTER didn't contaminate the anchor.
    expect(drafts[1].figures?.[0].storageKey).toBe('r2://q2-fig.png');
    expect(drafts[0].figures).toBeUndefined();
  });

  it('returns 0 / 0 when there are no figures and no tables', () => {
    const drafts: OcrEngineDraft[] = [draft({ position: 0, sourcePageNumber: 1 })];
    const regions: OcrRegion[] = [textRegion(1, 0, 100, 200)];
    const r = attachFiguresByRegions({ drafts, figuresByPage: new Map(), regions });
    expect(r.figuresAttached).toBe(0);
    expect(r.tablesAttached).toBe(0);
  });

  it('attaches a question_snapshot region by setting draft.questionSnapshotKey + needsImageReview', () => {
    const drafts = [draft({ position: 0, sourcePageNumber: 1, text: 'Q1' })];
    const regions: OcrRegion[] = [
      textRegion(1, 0, 100, 250),
      {
        type: 'FIGURE',
        pageNumber: 1,
        bbox: { x0: 50, y0: 110, x1: 800, y1: 260 },
        confidence: 0.0,
        readingOrder: 1,
        content: null,
        tableHtml: null,
        storageKey: 'r2://snap-1.png',
        metadata: { role: 'question_snapshot' },
      },
    ];
    const r = attachFiguresByRegions({ drafts, figuresByPage: new Map(), regions });
    expect(r.snapshotsAttached).toBe(1);
    expect(drafts[0].questionSnapshotKey).toBe('r2://snap-1.png');
    expect(drafts[0].needsImageReview).toBe(true);
  });

  it('handles pages with no PP-Structure text regions (image-only pages)', () => {
    // Edge case: a cover page is all image, no text regions detected. We still
    // want figures attached *somewhere* (to draft 0) rather than dropping them.
    const drafts: OcrEngineDraft[] = [draft({ position: 0, sourcePageNumber: 1 })];
    const regions: OcrRegion[] = []; // no PP-Structure text regions
    const figuresByPage = new Map([[1, [figure(1, 100, 800, 'r2://cover.png')]]]);
    const r = attachFiguresByRegions({ drafts, figuresByPage, regions });
    expect(r.figuresAttached).toBe(1);
    expect(drafts[0].figures?.[0].storageKey).toBe('r2://cover.png');
  });
});
