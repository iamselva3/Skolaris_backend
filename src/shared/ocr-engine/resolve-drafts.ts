/*
 * The SINGLE entry point both OCR consumers call after fetching bytes
 * (src/shared/workers/ocr.processor.ts and scripts/ocr-worker.ts). It decides
 * whether the existing Node/Tesseract result is final, or whether the job
 * should be handed off to the Python handwriting service.
 *
 * GUARANTEE: when HANDWRITING_OCR_ENABLED is not 'true', this is a literal
 * passthrough to extractDrafts(bytes, mime) — byte-identical to today, no word
 * collection, no routing. The whole fallback is opt-in.
 *
 * It NEVER lets routing logic break extraction: a real extraction failure
 * propagates to the caller's existing error handling unchanged; only the
 * (pure) routing evaluation is wrapped to degrade to the Node result.
 */
import { extractDrafts, type OcrEngineResult } from './ocr-engine';
import {
  computeSignal,
  decideRoute,
  preRoute,
  routingConfigFromEnv,
  type PreRouteResult,
  type RoutingConfig,
  type RoutingDecision,
  type RoutingSignal,
} from './routing';

export type HandwritingDispatch = 'queue' | 'http';

export interface HandwritingSettings {
  enabled: boolean;
  /** Shadow mode: run the classifier and LOG what it would do, but do NOT route
   *  (Node still posts its own result). For validating routing on real data. */
  shadow: boolean;
  /** How a routed job reaches the Python service: 'queue' (BullMQ, default) or
   *  'http' (synchronous POST to /ocr/extract — no second consumer needed). */
  dispatch: HandwritingDispatch;
  serviceUrl: string | null; // HANDWRITING_OCR_URL (http dispatch)
  timeoutMs: number;
  routing: RoutingConfig;
}

export type ResolveOutcome =
  | { kind: 'node'; result: OcrEngineResult } // post the callback as today
  // route: hand off to Python. `nodeResult` is the first-pass Node result,
  // carried so the http dispatcher can DEGRADE to it if the service is down.
  | { kind: 'route'; decision: RoutingDecision; nodeResult: OcrEngineResult };

/** DI-free settings read straight from process.env (works in the standalone script too). */
export const readHandwritingSettings = (): HandwritingSettings => ({
  enabled: process.env.HANDWRITING_OCR_ENABLED === 'true',
  shadow: process.env.HANDWRITING_OCR_SHADOW === 'true',
  dispatch: process.env.HW_OCR_DISPATCH === 'http' ? 'http' : 'queue',
  serviceUrl: process.env.HANDWRITING_OCR_URL || null,
  timeoutMs: Number(process.env.HANDWRITING_OCR_TIMEOUT_MS) || 120_000,
  routing: routingConfigFromEnv(process.env),
});

/** Structured, parseable routing-decision log — the data shadow mode collects. */
const logRoutingDecision = (
  storageKey: string,
  mime: string,
  signal: RoutingSignal,
  pre: PreRouteResult,
  decision: RoutingDecision,
  shadow: boolean,
  willRoute: boolean,
): void => {
  // eslint-disable-next-line no-console
  console.log(
    `[ocr-routing] ${JSON.stringify({
      storageKey,
      mime,
      shadow,
      willRoute,
      wouldRoute: decision.route,
      reason: decision.reason,
      score: decision.score,
      confidence: signal.overallConfidence,
      charsPerPage: Math.round(signal.charsPerPage),
      words: signal.words.wordCount,
      lowWordRatio: Math.round(signal.words.lowWordRatio * 100) / 100,
      preVerdict: pre.verdict,
      embeddedCharsPerPage: Math.round(pre.embeddedCharsPerPage),
    })}`,
  );
};

export const resolveDrafts = async (
  bytes: Buffer,
  mime: string,
  storageKey: string,
  deps: { settings: HandwritingSettings },
): Promise<ResolveOutcome> => {
  const { settings } = deps;

  // Flag OFF: exact current behaviour.
  if (!settings.enabled) {
    return { kind: 'node', result: await extractDrafts(bytes, mime) };
  }

  // Flag ON: first pass WITH word stats (extraction errors propagate to the
  // caller's existing try/catch exactly as before).
  const result = await extractDrafts(bytes, mime, { withWords: true });

  try {
    const pre = await preRoute({ storageKey, mime, bytes }, settings.routing);

    const raw = result.signalRaw;
    if (!raw) return { kind: 'node', result }; // no signal collected -> keep Node result

    const signal = computeSignal(
      {
        mime,
        overallConfidence: result.overallConfidence,
        text: raw.text,
        pageCount: raw.pageCount,
        wordConfidences: raw.wordConfidences,
        sentinel: raw.sentinel,
      },
      pre,
      settings.routing,
    );
    // decideRoute honours pre.forceNode (machine PDF) internally.
    const decision = decideRoute(signal, settings.routing);
    const willRoute = decision.route && !settings.shadow;
    logRoutingDecision(storageKey, mime, signal, pre, decision, settings.shadow, willRoute);
    return willRoute ? { kind: 'route', decision, nodeResult: result } : { kind: 'node', result };
  } catch (err) {
    // Routing must never regress extraction — keep the already-computed Node result.
    // eslint-disable-next-line no-console
    console.error(
      `[resolve-drafts] routing evaluation failed; using Node result: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: 'node', result };
  }
};
