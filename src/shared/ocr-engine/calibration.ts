/*
 * Phase-4 routing calibration (pure, DI-free).
 *
 * Turns the structured `[ocr-routing] {...}` decision logs emitted by shadow
 * mode (resolve-drafts.ts) into:
 *   - a summary (route rate, reason / pre-verdict histograms, score buckets), and
 *   - (when a label map is supplied) a confusion matrix + precision/recall/F1
 *     across a sweep of score thresholds, plus a recommended threshold.
 *
 * Defaults in routing.ts are reasoned estimates, NOT empirically tuned — collect
 * real shadow logs, label them printed/handwritten, run this, then set
 * OCR_ROUTE_SCORE_THRESHOLD (and weights) accordingly.
 */

export interface RoutingRecord {
  storageKey: string;
  mime: string;
  wouldRoute: boolean;
  reason: string;
  score: number;
  confidence: number;
  charsPerPage: number;
  words: number;
  lowWordRatio: number;
  preVerdict: string;
  embeddedCharsPerPage: number;
}

export type Label = 'handwritten' | 'printed';

export interface Summary {
  total: number;
  routedCount: number; // wouldRoute === true
  routeRate: number; // 0..1
  reasonHistogram: Record<string, number>;
  preVerdictHistogram: Record<string, number>;
  scoreBuckets: Record<string, number>; // '0.0-0.2' ... '0.8-1.0'
}

export interface ThresholdResult {
  threshold: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
}

const MARKER = '[ocr-routing] ';

const numOr = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const strOr = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
const boolOr = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);

const coerce = (o: Record<string, unknown>): RoutingRecord => ({
  storageKey: strOr(o.storageKey, ''),
  mime: strOr(o.mime, ''),
  wouldRoute: boolOr(o.wouldRoute, false),
  reason: strOr(o.reason, ''),
  score: numOr(o.score, 0),
  confidence: numOr(o.confidence, 0),
  charsPerPage: numOr(o.charsPerPage, 0),
  words: numOr(o.words, 0),
  lowWordRatio: numOr(o.lowWordRatio, 0),
  preVerdict: strOr(o.preVerdict, ''),
  embeddedCharsPerPage: numOr(o.embeddedCharsPerPage, 0),
});

/** Extract routing records from raw log lines (tolerates any leading prefix). */
export const parseRoutingLogLines = (lines: string[]): RoutingRecord[] => {
  const out: RoutingRecord[] = [];
  for (const line of lines) {
    const idx = line.indexOf(MARKER);
    if (idx === -1) continue;
    const json = line.slice(idx + MARKER.length).trim();
    try {
      const o = JSON.parse(json) as Record<string, unknown>;
      out.push(coerce(o));
    } catch {
      // skip malformed line
    }
  }
  return out;
};

const SCORE_BUCKETS = ['0.0-0.2', '0.2-0.4', '0.4-0.6', '0.6-0.8', '0.8-1.0'];
const bucketOf = (score: number): string => {
  const i = Math.min(4, Math.max(0, Math.floor(score * 5)));
  return SCORE_BUCKETS[i];
};

export const summarize = (records: RoutingRecord[]): Summary => {
  const reasonHistogram: Record<string, number> = {};
  const preVerdictHistogram: Record<string, number> = {};
  const scoreBuckets: Record<string, number> = Object.fromEntries(SCORE_BUCKETS.map((b) => [b, 0]));
  let routedCount = 0;
  for (const r of records) {
    if (r.wouldRoute) routedCount += 1;
    reasonHistogram[r.reason] = (reasonHistogram[r.reason] ?? 0) + 1;
    preVerdictHistogram[r.preVerdict] = (preVerdictHistogram[r.preVerdict] ?? 0) + 1;
    scoreBuckets[bucketOf(r.score)] += 1;
  }
  return {
    total: records.length,
    routedCount,
    routeRate: records.length ? routedCount / records.length : 0,
    reasonHistogram,
    preVerdictHistogram,
    scoreBuckets,
  };
};

/**
 * Predict whether a record routes at score threshold `t`. Hard-override reasons
 * are independent of the score threshold and keep their logged decision; only
 * the score-driven reasons are swept.
 */
export const predictRoute = (r: RoutingRecord, t: number): boolean => {
  switch (r.reason) {
    case 'machine_text_force_node':
      return false;
    case 'near_empty':
    case 'answer_sheet_hint':
      return true;
    case 'low_confidence_small_sample':
    case 'high_confidence_small_sample':
      return r.wouldRoute;
    default: // 'score_threshold' | 'below_threshold' | anything score-driven
      return r.score >= t;
  }
};

const round = (n: number): number => Math.round(n * 1000) / 1000;

export const defaultThresholdSweep = (): number[] =>
  Array.from({ length: 21 }, (_, i) => round(i / 20)); // 0.00 .. 1.00 step 0.05

/** Confusion + P/R/F1 across thresholds. Positive class = 'handwritten' (should route). */
export const evaluate = (
  records: RoutingRecord[],
  labels: Record<string, Label>,
  thresholds: number[] = defaultThresholdSweep(),
): ThresholdResult[] => {
  const labeled = records.filter((r) => labels[r.storageKey] !== undefined);
  return thresholds.map((threshold) => {
    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;
    for (const r of labeled) {
      const isHandwritten = labels[r.storageKey] === 'handwritten';
      const routed = predictRoute(r, threshold);
      if (routed && isHandwritten) tp += 1;
      else if (routed && !isHandwritten) fp += 1;
      else if (!routed && isHandwritten) fn += 1;
      else tn += 1;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    const total = tp + fp + tn + fn;
    return {
      threshold,
      tp,
      fp,
      tn,
      fn,
      precision: round(precision),
      recall: round(recall),
      f1: round(f1),
      accuracy: total === 0 ? 0 : round((tp + tn) / total),
    };
  });
};

/**
 * Recommend a threshold. With `minPrecision`, pick the result meeting it with the
 * highest recall (lowest threshold on ties). Otherwise maximise F1.
 */
export const recommendThreshold = (
  results: ThresholdResult[],
  opts: { minPrecision?: number } = {},
): ThresholdResult | null => {
  if (results.length === 0) return null;
  if (opts.minPrecision !== undefined) {
    const ok = results.filter((r) => r.precision >= opts.minPrecision!);
    if (ok.length === 0) return null;
    return ok.reduce((best, r) =>
      r.recall > best.recall || (r.recall === best.recall && r.threshold < best.threshold) ? r : best,
    );
  }
  return results.reduce((best, r) => (r.f1 > best.f1 ? r : best));
};
