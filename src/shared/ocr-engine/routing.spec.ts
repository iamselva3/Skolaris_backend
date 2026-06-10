import {
  computeSignal,
  decideRoute,
  defaultRoutingConfig,
  preRoute,
  routingConfigFromEnv,
  wordStatsFromConfidences,
  type PreRouteResult,
} from './routing';

const cfg = defaultRoutingConfig();
const noHintPre: PreRouteResult = {
  verdict: 'INCONCLUSIVE',
  forceNode: false,
  isAnswerSheetHint: false,
  embeddedCharsPerPage: 0,
};

describe('routing/wordStatsFromConfidences', () => {
  it('returns zeros for no words', () => {
    expect(wordStatsFromConfidences([], 60)).toEqual({
      wordCount: 0,
      medianWordConfidence: 0,
      lowWordRatio: 0,
    });
  });

  it('computes median and low-word ratio', () => {
    const s = wordStatsFromConfidences([90, 20, 80, 40, 95], 60);
    expect(s.wordCount).toBe(5);
    expect(s.medianWordConfidence).toBe(80); // sorted [20,40,80,90,95] -> middle 80
    expect(s.lowWordRatio).toBeCloseTo(2 / 5); // 20 and 40 are < 60
  });
});

describe('routing/decideRoute', () => {
  const signalWith = (over: Partial<ReturnType<typeof computeSignal>>) =>
    ({
      mime: 'image/png',
      pre: noHintPre,
      overallConfidence: 0.9,
      charsPerPage: 200,
      alphaNoiseRatio: 0,
      nonDictTokenRatio: 0,
      nearEmpty: false,
      words: { wordCount: 20, medianWordConfidence: 90, lowWordRatio: 0 },
      ...over,
    }) as ReturnType<typeof computeSignal>;

  it('forces Node when pre-verdict is MACHINE_TEXT', () => {
    const d = decideRoute(
      signalWith({
        pre: {
          verdict: 'MACHINE_TEXT',
          forceNode: true,
          isAnswerSheetHint: false,
          embeddedCharsPerPage: 500,
        },
      }),
      cfg,
    );
    expect(d.route).toBe(false);
    expect(d.reason).toBe('machine_text_force_node');
  });

  it('routes when near-empty', () => {
    expect(decideRoute(signalWith({ nearEmpty: true }), cfg).route).toBe(true);
  });

  it('keeps clean high-confidence printed text on Node', () => {
    expect(decideRoute(signalWith({}), cfg).route).toBe(false);
  });

  it('routes low-confidence handwriting-like input', () => {
    const d = decideRoute(
      signalWith({
        overallConfidence: 0.4,
        charsPerPage: 30,
        alphaNoiseRatio: 0.4,
        words: { wordCount: 20, medianWordConfidence: 35, lowWordRatio: 0.8 },
      }),
      cfg,
    );
    expect(d.route).toBe(true);
  });

  it('small sample trusts confidence only', () => {
    const small = signalWith({
      overallConfidence: 0.4,
      words: { wordCount: 3, medianWordConfidence: 0, lowWordRatio: 0 },
    });
    expect(decideRoute(small, cfg).route).toBe(true);
    const smallHigh = signalWith({
      overallConfidence: 0.95,
      words: { wordCount: 3, medianWordConfidence: 0, lowWordRatio: 0 },
    });
    expect(decideRoute(smallHigh, cfg).route).toBe(false);
  });
});

describe('routing/computeSignal + preRoute', () => {
  it('derives charsPerPage and nearEmpty from the engine output', () => {
    const sig = computeSignal(
      {
        mime: 'application/pdf',
        overallConfidence: 0.5,
        text: 'abc',
        pageCount: 1,
        wordConfidences: [50],
        sentinel: false,
      },
      noHintPre,
      cfg,
    );
    expect(sig.charsPerPage).toBe(3);
    expect(sig.nearEmpty).toBe(true); // 3 < emptyCharsPerPage (15)
  });

  it('flags answer-sheet path hints (image: no PDF probe)', async () => {
    const pre = await preRoute(
      { storageKey: 'tenants/x/uploads/2026/answer-sheet-12.jpg', mime: 'image/jpeg' },
      cfg,
    );
    expect(pre.isAnswerSheetHint).toBe(true);
    expect(pre.forceNode).toBe(false);
    expect(pre.verdict).toBe('INCONCLUSIVE');
  });
});

describe('routing/routingConfigFromEnv', () => {
  it('falls back to defaults and honors overrides', () => {
    expect(routingConfigFromEnv({}).scoreThreshold).toBe(cfg.scoreThreshold);
    expect(routingConfigFromEnv({ OCR_ROUTE_SCORE_THRESHOLD: '0.8' }).scoreThreshold).toBe(0.8);
  });
});
