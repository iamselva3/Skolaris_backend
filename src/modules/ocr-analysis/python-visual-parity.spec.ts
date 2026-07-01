import { OcrAnalysisDeliveryService } from './ocr-analysis-delivery.service';
import * as http from '../../shared/ocr-engine/structure-analyze-http';

/**
 * SCREENSHOT-FIRST VISUAL PARITY (regression lock). The Python delivery path must produce VISUAL
 * questions — the crop image is the source of truth. It must NEVER emit a text `detectedType`
 * (SINGLE_CHOICE/…) or an extracted a/b/c/d `options` array, which would make the UI render a
 * textarea + empty option fields (the reported hard regression). `optionCount` (positional
 * correct-option selector) and `questionSnapshotKey` (crop image) must be preserved.
 */
jest.mock('../../shared/ocr-engine/structure-analyze-http', () => ({
  readStructureBuildSettings: jest.fn(() => ({ enabled: true, serviceUrl: 'http://sidecar', timeoutMs: 1000 })),
  readStructureAnalyzeSettings: jest.fn(() => ({ enabled: false, serviceUrl: '' })),
  processDocumentHttp: jest.fn(),
  buildDocumentHttp: jest.fn(),
  analyzeDocumentHttp: jest.fn(),
}));

const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');

const makeResult = () => ({
  deliver: true,
  ocrDegradedPages: 0,
  questions: [
    // an option-bearing question (4 options, NOT a diagram) — the case that previously became SINGLE_CHOICE
    { id: 'q1', number: 1, optionCount: 4, hasDiagram: false, startPage: 0, endPage: 0, boxes: [{ text: 'Which is not a base unit?' }], options: [{ label: 'A) Meter' }] },
    { id: 'q2', number: 2, optionCount: 4, hasDiagram: true, startPage: 0, endPage: 0, boxes: [{ text: 'See the diagram' }] },
  ],
  crops: [
    { questionId: 'q1', number: 1, pngBase64: PNG_B64, valid: true, edges: {} },
    { questionId: 'q2', number: 2, pngBase64: PNG_B64, valid: true, edges: {} },
  ],
  build: { cropCount: 2, stage2: { status: 'PASS' } },
  integrity: { nnc: { stage1: { pass: true, ownershipCount: 2, completeQuestionCount: 2 } } },
  sequence: { duplicates: [], questionZero: false, impossible: [] },
  questionCount: { recoveredQuestions: [], missingQuestions: [] },
  ownershipHeatmap: [],
});

describe('deliverPythonDocument — screenshot-first VISUAL parity', () => {
  const io = {
    getObject: jest.fn(),
    putObject: jest.fn().mockResolvedValue(undefined),
    figureKeyPrefix: 'tenants/t/ocr-figures/job',
  };
  const svc = new OcrAnalysisDeliveryService(null as never);

  beforeEach(() => jest.clearAllMocks());

  it('emits VISUAL drafts with crop image + optionCount, and NO options array / NO text type', async () => {
    (http.processDocumentHttp as jest.Mock).mockResolvedValue(makeResult());

    const out = await svc.deliverPythonDocument('storage/key', 'job', io);
    expect(out).not.toBeNull();
    expect(out!.deliver).toBe(true);
    expect(out!.drafts).toHaveLength(2);

    for (const d of out!.drafts) {
      // VISUAL is mandatory — never a text question type
      expect((d as { detectedType?: string }).detectedType).toBe('VISUAL');
      // never an extracted a/b/c/d option array (that renders the empty option fields)
      expect((d as { options?: unknown }).options).toBeUndefined();
      // the crop image is the source of truth
      expect(d.questionSnapshotKey).toBeTruthy();
      // positional correct-option selector preserved
      expect((d as { optionCount?: number }).optionCount).toBe(4);
    }
    // the crop PNGs were stored
    expect(io.putObject).toHaveBeenCalledTimes(2);
  });

  it('keeps an option-bearing question VISUAL (does NOT downgrade to SINGLE_CHOICE)', async () => {
    (http.processDocumentHttp as jest.Mock).mockResolvedValue(makeResult());
    const out = await svc.deliverPythonDocument('storage/key', 'job', io);
    const q1 = out!.drafts.find((d) => d.questionNumber === 1)!;
    expect((q1 as { detectedType?: string }).detectedType).toBe('VISUAL');
    expect((q1 as { options?: unknown }).options).toBeUndefined();
  });
});
