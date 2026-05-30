import { dispatchHandwritingHttp, getBreakerState, resetBreaker } from './handwriting-http';

const realFetch = global.fetch;
const input = { ocrJobId: 'j1', storageKey: 'k.png', mime: 'image/png' };
const deps = { serviceUrl: 'http://hw:8001', timeoutMs: 1000 };

let fetchMock: jest.Mock;

beforeEach(() => {
  resetBreaker();
  fetchMock = jest.fn();
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});
afterAll(() => {
  (global as unknown as { fetch: unknown }).fetch = realFetch;
});

describe('handwriting-http dispatcher', () => {
  it('returns null and never calls fetch when no serviceUrl is configured', async () => {
    const r = await dispatchHandwritingHttp(input, { serviceUrl: null, timeoutMs: 1000 });
    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a successful response to an OcrEngineResult (detectedType defaulted)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ providerUsed: 'paddle-hw', overallConfidence: 0.62, drafts: [{ position: 0, text: 'Q1' }] }),
    });
    const r = await dispatchHandwritingHttp(input, deps);
    expect(r).not.toBeNull();
    expect(r?.providerUsed).toBe('paddle-hw');
    expect(r?.overallConfidence).toBe(0.62);
    expect(r?.drafts).toHaveLength(1);
    expect(r?.drafts[0].detectedType).toBe('DESCRIPTIVE');
  });

  it('returns null on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    expect(await dispatchHandwritingHttp(input, deps)).toBeNull();
  });

  it('returns null on a network error', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await dispatchHandwritingHttp(input, deps)).toBeNull();
  });

  it('opens the circuit after repeated failures and short-circuits (no fetch)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    for (let i = 0; i < 3; i += 1) {
      expect(await dispatchHandwritingHttp(input, deps)).toBeNull();
    }
    expect(getBreakerState().open).toBe(true);
    const callsBefore = fetchMock.mock.calls.length;
    expect(await dispatchHandwritingHttp(input, deps)).toBeNull(); // circuit open
    expect(fetchMock.mock.calls.length).toBe(callsBefore); // did not call fetch again
  });
});
