import {
  defaultThresholdSweep,
  evaluate,
  parseRoutingLogLines,
  predictRoute,
  recommendThreshold,
  summarize,
  type Label,
  type RoutingRecord,
} from './calibration';

const rec = (over: Partial<RoutingRecord> = {}): RoutingRecord => ({
  storageKey: 'k',
  mime: 'image/png',
  wouldRoute: false,
  reason: 'below_threshold',
  score: 0.2,
  confidence: 0.9,
  charsPerPage: 200,
  words: 30,
  lowWordRatio: 0.05,
  preVerdict: 'INCONCLUSIVE',
  embeddedCharsPerPage: 0,
  ...over,
});

const logLine = (r: Partial<RoutingRecord>): string =>
  `2026-05-29 ... [ocr-routing] ${JSON.stringify(rec(r))}`;

describe('calibration/parseRoutingLogLines', () => {
  it('extracts records regardless of leading prefix and skips malformed lines', () => {
    const lines = [
      logLine({ storageKey: 'a.pdf', wouldRoute: true, score: 0.8 }),
      'unrelated log line',
      '[ocr-routing] {not json}',
      logLine({ storageKey: 'b.png', wouldRoute: false, score: 0.1 }),
    ];
    const records = parseRoutingLogLines(lines);
    expect(records).toHaveLength(2);
    expect(records[0].storageKey).toBe('a.pdf');
    expect(records[1].score).toBe(0.1);
  });
});

describe('calibration/summarize', () => {
  it('computes route rate, histograms and score buckets', () => {
    const s = summarize([
      rec({ wouldRoute: true, score: 0.9, reason: 'score_threshold' }),
      rec({ wouldRoute: false, score: 0.1, reason: 'below_threshold' }),
      rec({ wouldRoute: true, score: 0.7, reason: 'near_empty', preVerdict: 'SCAN_LIKELY' }),
    ]);
    expect(s.total).toBe(3);
    expect(s.routedCount).toBe(2);
    expect(s.routeRate).toBeCloseTo(2 / 3);
    expect(s.reasonHistogram.score_threshold).toBe(1);
    expect(s.scoreBuckets['0.8-1.0']).toBe(1);
    expect(s.scoreBuckets['0.6-0.8']).toBe(1);
  });
});

describe('calibration/predictRoute', () => {
  it('honors hard-override reasons and sweeps score-driven ones', () => {
    expect(predictRoute(rec({ reason: 'machine_text_force_node', score: 0.99 }), 0.5)).toBe(false);
    expect(predictRoute(rec({ reason: 'near_empty', score: 0 }), 0.5)).toBe(true);
    expect(
      predictRoute(rec({ reason: 'low_confidence_small_sample', wouldRoute: true }), 0.9),
    ).toBe(true);
    expect(predictRoute(rec({ reason: 'score_threshold', score: 0.6 }), 0.5)).toBe(true);
    expect(predictRoute(rec({ reason: 'score_threshold', score: 0.4 }), 0.5)).toBe(false);
  });
});

describe('calibration/evaluate + recommendThreshold', () => {
  // 2 handwritten (high score) + 2 printed (low score) — cleanly separable at ~0.5.
  const records: RoutingRecord[] = [
    rec({ storageKey: 'hw1', reason: 'score_threshold', score: 0.8 }),
    rec({ storageKey: 'hw2', reason: 'score_threshold', score: 0.6 }),
    rec({ storageKey: 'pr1', reason: 'below_threshold', score: 0.2 }),
    rec({ storageKey: 'pr2', reason: 'below_threshold', score: 0.1 }),
  ];
  const labels: Record<string, Label> = {
    hw1: 'handwritten',
    hw2: 'handwritten',
    pr1: 'printed',
    pr2: 'printed',
  };

  it('produces a perfect split at a mid threshold', () => {
    const results = evaluate(records, labels, defaultThresholdSweep());
    const best = recommendThreshold(results);
    expect(best).not.toBeNull();
    expect(best!.precision).toBe(1);
    expect(best!.recall).toBe(1);
    expect(best!.f1).toBe(1);
    expect(best!.threshold).toBeGreaterThan(0.2);
    expect(best!.threshold).toBeLessThanOrEqual(0.6);
  });

  it('respects a minimum-precision target', () => {
    const results = evaluate(records, labels);
    const rec80 = recommendThreshold(results, { minPrecision: 0.8 });
    expect(rec80).not.toBeNull();
    expect(rec80!.precision).toBeGreaterThanOrEqual(0.8);
  });

  it('ignores unlabeled records', () => {
    const withExtra = [
      ...records,
      rec({ storageKey: 'unlabeled', score: 0.95, reason: 'score_threshold' }),
    ];
    const results = evaluate(withExtra, labels, [0.5]);
    expect(results[0].tp + results[0].fp + results[0].tn + results[0].fn).toBe(4);
  });
});
