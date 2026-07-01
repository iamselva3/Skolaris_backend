import sharp from 'sharp';
import { OcrAnalysisDeliveryService } from './ocr-analysis-delivery.service';

/**
 * RECOVERED-OPTION CROP EXTENSION (regression lock). When Python's pre-delivery validator proves
 * extra options belong to the SAME owner (recoveredRegions), TS must WIDEN/STITCH its existing crop
 * — never build a new crop, never cross the next confirmed owner. An extension that would pull in a
 * neighbour routes ONLY that question to review (never the whole document).
 */

const PAGE_W = 600;
const PAGE_H = 900;

const whitePage = (): Promise<Buffer> =>
  sharp({ create: { width: PAGE_W, height: PAGE_H, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .png()
    .toBuffer();

const smallPng = (): Promise<Buffer> =>
  sharp({ create: { width: 300, height: 120, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .png()
    .toBuffer();

const makeIO = (existing: Buffer) => ({
  getObject: jest.fn().mockResolvedValue(existing),
  putObject: jest.fn().mockResolvedValue(undefined),
  figureKeyPrefix: 'tenants/t/ocr-figures/job',
});

// A minimal proposal question carrying a proven ownership + recovered regions.
const q = (over: Record<string, unknown>) => ({
  id: 'q1',
  number: 1,
  startPage: 1,
  endPage: 1,
  boxes: [{ kind: 'QUESTION_TEXT', page: 1, x0: 50, y0: 40, x1: 550, y1: 200 }],
  optionCount: 4,
  merges: [],
  multiColumn: false,
  multiPage: false,
  multiBlock: false,
  hasDiagram: false,
  complete: false,
  confidence: 1,
  confidencePct: 100,
  tier: 'TS_FULL',
  needsReview: false,
  reviewReasons: [],
  numberBox: [1, 50, 40, 70, 56],
  cropAllowed: true,
  ownershipReport: { ownerPass: true, nextQuestionSafe: true, cropAllowed: true },
  ...over,
});

describe('applyRecoveredOptionsToTsCrops', () => {
  const svc = new OcrAnalysisDeliveryService(null as never);
  const ORIG = process.env.OCR_CROP_RAW_CONTENT;

  beforeAll(() => {
    process.env.OCR_CROP_RAW_CONTENT = 'true'; // raw crop = no sharp clean / lift (fast, deterministic)
  });
  afterAll(() => {
    process.env.OCR_CROP_RAW_CONTENT = ORIG;
  });

  it('WIDENS a same-column crop to the recovered options and bumps optionCount', async () => {
    const page = await whitePage();
    const io = makeIO(await smallPng());
    const draft: Record<string, unknown> = {
      position: 0,
      questionNumber: 1,
      detectedType: 'VISUAL',
      optionCount: 2, // only A/B captured
      questionSnapshotKey: 'old/key.png',
      sourcePageNumber: 1,
      spanPageStart: 1,
      spanPageEnd: 1,
      sourceCoordinates: { x0: 50, y0: 40, x1: 550, y1: 200 },
    };
    const proposal = {
      questions: [
        q({ deliveryReport: { recoveredRegions: [{ page: 1, x0: 60, y0: 210, x1: 540, y1: 280 }] } }),
        // next owner well below — does NOT bound away the recovered region
        q({ id: 'q2', number: 2, numberBox: [1, 50, 400, 70, 416], deliveryReport: {} }),
      ],
    };
    const artifacts = { pageImages: [page], wordsByPage: [[]] };

    const res = await (svc as any).applyRecoveredOptionsToTsCrops([draft], proposal, artifacts, io);
    expect(res.extended).toBe(1);
    expect(res.reviewed).toBe(0);
    expect(draft.questionSnapshotKey).not.toBe('old/key.png'); // crop replaced with a wider one
    expect((draft.sourceCoordinates as { y1: number }).y1).toBeGreaterThan(200); // taller
    expect(draft.optionCount).toBe(4); // now complete
    expect((draft as { invalidCrop?: boolean }).invalidCrop).toBeFalsy();
  });

  it('does NOT touch a complete question (no recoveredRegions)', async () => {
    const page = await whitePage();
    const io = makeIO(await smallPng());
    const draft: Record<string, unknown> = {
      position: 0,
      questionNumber: 1,
      optionCount: 4,
      questionSnapshotKey: 'keep/key.png',
      sourcePageNumber: 1,
      spanPageStart: 1,
      spanPageEnd: 1,
      sourceCoordinates: { x0: 50, y0: 40, x1: 550, y1: 200 },
    };
    const proposal = { questions: [q({ deliveryReport: {} })] };
    const res = await (svc as any).applyRecoveredOptionsToTsCrops([draft], proposal, { pageImages: [page], wordsByPage: [[]] }, io);
    expect(res.extended).toBe(0);
    expect(draft.questionSnapshotKey).toBe('keep/key.png');
  });

  it('routes ONLY the offending question to review when extension would swallow a neighbour', async () => {
    const page = await whitePage();
    const io = makeIO(await smallPng());
    const draft: Record<string, unknown> = {
      position: 0,
      questionNumber: 1,
      optionCount: 2,
      questionSnapshotKey: 'old/key.png',
      sourcePageNumber: 1,
      spanPageStart: 1,
      spanPageEnd: 1,
      sourceCoordinates: { x0: 50, y0: 40, x1: 300, y1: 200 }, // left column
    };
    const proposal = {
      questions: [
        // recovered region sits in the RIGHT column (stitch path) …
        q({ deliveryReport: { recoveredRegions: [{ page: 1, x0: 320, y0: 40, x1: 580, y1: 300 }] } }),
        // … but another owner's NUMBER is inside that region → unsafe
        q({ id: 'q2', number: 2, numberBox: [1, 330, 100, 350, 116], deliveryReport: {} }),
      ],
    };
    const res = await (svc as any).applyRecoveredOptionsToTsCrops([draft], proposal, { pageImages: [page], wordsByPage: [[]] }, io);
    expect(res.extended).toBe(0);
    expect(res.reviewed).toBe(1);
    expect((draft as { invalidCrop?: boolean }).invalidCrop).toBe(true);
    expect((draft as { needsImageReview?: boolean }).needsImageReview).toBe(true);
    expect((draft as { structuralReview?: string[] }).structuralReview).toContain('recovered_extension_unsafe');
    expect(draft.questionSnapshotKey).toBe('old/key.png'); // crop untouched
  });
});
