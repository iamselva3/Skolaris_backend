import { extractDrafts, type OcrEngineResult } from './ocr-engine';
import { resolveDrafts, type HandwritingSettings } from './resolve-drafts';
import { defaultRoutingConfig } from './routing';

jest.mock('./ocr-engine', () => ({ extractDrafts: jest.fn() }));
const mockExtract = extractDrafts as jest.MockedFunction<typeof extractDrafts>;

const bytes = Buffer.from('img');
const settings = (enabled: boolean, shadow = false): HandwritingSettings => ({
  enabled,
  shadow,
  dispatch: 'queue',
  serviceUrl: null,
  timeoutMs: 120_000,
  routing: defaultRoutingConfig(),
});

const lowConfResult = (): OcrEngineResult => ({
  providerUsed: 'tesseract',
  overallConfidence: 0.4,
  drafts: [{ position: 0, text: 'sdf gkj lkw qpz', detectedType: 'DESCRIPTIVE', confidence: 0.4 }],
  signalRaw: {
    text: 'sdf gkj lkw qpz',
    pageCount: 1,
    wordConfidences: [30, 40, 20, 50, 35, 45, 25, 55, 30, 40],
    sentinel: false,
  },
});

const nodeResult = (over: Partial<OcrEngineResult> = {}): OcrEngineResult => ({
  providerUsed: 'tesseract',
  overallConfidence: 0.95,
  drafts: [
    {
      position: 0,
      text: 'A clear printed question with plenty of words',
      detectedType: 'DESCRIPTIVE',
      confidence: 0.95,
    },
  ],
  ...over,
});

describe('resolveDrafts', () => {
  beforeEach(() => mockExtract.mockReset());

  it('flag OFF: passthrough to extractDrafts WITHOUT word collection (byte-identical path)', async () => {
    mockExtract.mockResolvedValue(nodeResult());
    const out = await resolveDrafts(bytes, 'image/png', 'k.png', { settings: settings(false) });
    expect(out.kind).toBe('node');
    expect(mockExtract).toHaveBeenCalledTimes(1);
    // storageKey is now plumbed through so the Slice 2.2 Paddle dispatcher can
    // reach the read-proxy when PRINTED_OCR_VIA_PADDLE=true. With the flag off,
    // extractDrafts ignores it and runs byte-identically to before.
    expect(mockExtract).toHaveBeenCalledWith(bytes, 'image/png', { storageKey: 'k.png' });
  });

  it('flag ON + high-confidence printed: keeps Node result, requests words', async () => {
    mockExtract.mockResolvedValue(
      nodeResult({
        signalRaw: {
          text: 'A clear printed question with plenty of words and more text to exceed the per-page char threshold easily',
          pageCount: 1,
          wordConfidences: [90, 92, 88, 95, 91, 89, 93, 90, 94, 88],
          sentinel: false,
        },
      }),
    );
    const out = await resolveDrafts(bytes, 'image/png', 'k.png', { settings: settings(true) });
    expect(out.kind).toBe('node');
    expect(mockExtract).toHaveBeenCalledWith(bytes, 'image/png', {
      withWords: true,
      storageKey: 'k.png',
    });
  });

  it('flag ON + low-confidence handwriting-like: routes to the Python fallback', async () => {
    mockExtract.mockResolvedValue(
      nodeResult({
        overallConfidence: 0.4,
        signalRaw: {
          text: 'sdf gkj lkw qpz',
          pageCount: 1,
          wordConfidences: [30, 40, 20, 50, 35, 45, 25, 55, 30, 40],
          sentinel: false,
        },
      }),
    );
    const out = await resolveDrafts(bytes, 'image/png', 'k.png', { settings: settings(true) });
    expect(out.kind).toBe('route');
  });

  it('flag ON + near-empty extraction: routes', async () => {
    mockExtract.mockResolvedValue(
      nodeResult({
        overallConfidence: 0.2,
        signalRaw: { text: '', pageCount: 1, wordConfidences: [], sentinel: true },
      }),
    );
    const out = await resolveDrafts(bytes, 'image/png', 'k.png', { settings: settings(true) });
    expect(out.kind).toBe('route');
  });

  it('SHADOW mode: would-route input is NOT routed (Node result kept)', async () => {
    mockExtract.mockResolvedValue(lowConfResult());
    const out = await resolveDrafts(bytes, 'image/png', 'k.png', {
      settings: settings(true, true),
    });
    expect(out.kind).toBe('node'); // classifier would route, but shadow suppresses it
  });
});
