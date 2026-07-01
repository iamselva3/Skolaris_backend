import {
  analyzeDocumentHttp,
  readStructureAnalyzeSettings,
  resetStructureAnalyzeBreaker,
  type AnalyzeDocInput,
} from './structure-analyze-http';

const realFetch = global.fetch;
const input: AnalyzeDocInput = {
  documentId: 'doc1',
  pages: [{ index: 1, width: 650, height: 900, words: [{ text: '1.', x0: 60, y0: 40, x1: 76, y1: 56 }] }],
};
const deps = { serviceUrl: 'http://localhost:8002', timeoutMs: 1000 };

let fetchMock: jest.Mock;

beforeEach(() => {
  resetStructureAnalyzeBreaker();
  fetchMock = jest.fn();
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});
afterAll(() => {
  (global as unknown as { fetch: unknown }).fetch = realFetch;
});

describe('structure-analyze-http client', () => {
  it('returns null and never calls fetch when no serviceUrl is configured', async () => {
    const r = await analyzeDocumentHttp(input, { serviceUrl: null, timeoutMs: 1000 });
    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the structural proposal on a 200 response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        documentId: 'doc1',
        schemaVersion: 1,
        pageClasses: [],
        questions: [{ id: 'q1', number: 1, needsReview: false, optionCount: 4, merges: [] }],
        orphans: [],
        sequence: { duplicates: [], questionZero: false, impossible: [], gaps: [] },
        confidence: 0.9,
        recommendation: 'ACCEPT',
        notes: [],
      }),
    });
    const r = await analyzeDocumentHttp(input, deps);
    expect(r).not.toBeNull();
    expect(r?.recommendation).toBe('ACCEPT');
    expect(r?.questions).toHaveLength(1);
  });

  it('returns null on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    expect(await analyzeDocumentHttp(input, deps)).toBeNull();
  });

  it('returns null on a network error', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await analyzeDocumentHttp(input, deps)).toBeNull();
  });

  it('opens the circuit breaker after repeated failures (degrades instantly)', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    await analyzeDocumentHttp(input, deps);
    await analyzeDocumentHttp(input, deps);
    await analyzeDocumentHttp(input, deps);
    const callsAfterOpen = fetchMock.mock.calls.length;
    await analyzeDocumentHttp(input, deps); // circuit open → no new fetch
    expect(fetchMock.mock.calls.length).toBe(callsAfterOpen);
  });

  it('is opt-in: disabled by default', () => {
    delete process.env.STRUCTURE_ANALYZE_ENABLED;
    expect(readStructureAnalyzeSettings().enabled).toBe(false);
    process.env.STRUCTURE_ANALYZE_ENABLED = 'true';
    expect(readStructureAnalyzeSettings().enabled).toBe(true);
    delete process.env.STRUCTURE_ANALYZE_ENABLED;
  });
});
