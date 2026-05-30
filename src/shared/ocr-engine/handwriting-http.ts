/*
 * Optional INLINE-HTTP dispatch (Phase 5). Instead of enqueuing onto the
 * 'ocr.handwriting' BullMQ queue, the consumer can call the Python service's
 * synchronous POST /ocr/extract and persist the returned drafts itself — for
 * low-infra deployments that don't want to run a second (queue-consuming)
 * process. Selected via HW_OCR_DISPATCH=http.
 *
 * DI-free (shared by both consumers). Hardened with an AbortController timeout
 * and a tiny circuit breaker so a slow/dead service degrades fast to the Node
 * result instead of stalling every routed job. ANY failure returns null ⇒ the
 * caller keeps the already-computed Node result (never a stuck upload).
 */
import type { OcrEngineDraft, OcrEngineResult } from './ocr-engine';

export interface HttpDispatchInput {
  ocrJobId: string;
  storageKey: string;
  mime: string;
}
export interface HttpDispatchDeps {
  serviceUrl: string | null;
  timeoutMs: number;
}

const THRESHOLD = Number(process.env.HW_OCR_BREAKER_THRESHOLD) || 3;
const COOLDOWN_MS = Number(process.env.HW_OCR_BREAKER_COOLDOWN_MS) || 30_000;

const breaker = { failures: 0, openUntil: 0 };

export const getBreakerState = (): { failures: number; open: boolean; openUntil: number } => ({
  failures: breaker.failures,
  open: breaker.openUntil > Date.now(),
  openUntil: breaker.openUntil,
});

/** Test/ops helper to clear breaker state. */
export const resetBreaker = (): void => {
  breaker.failures = 0;
  breaker.openUntil = 0;
};

const recordFailure = (): void => {
  breaker.failures += 1;
  if (breaker.failures >= THRESHOLD) breaker.openUntil = Date.now() + COOLDOWN_MS;
};

interface ExtractResponse {
  providerUsed?: string;
  overallConfidence?: number;
  drafts?: Array<{
    position: number;
    text: string;
    detectedType?: string;
    options?: Array<{ label: string; isCorrect?: boolean }>;
    confidence?: number;
  }>;
}

/**
 * Returns the Python-derived result, or null on any failure / circuit-open /
 * timeout / no URL configured (⇒ caller degrades to the Node result).
 */
export const dispatchHandwritingHttp = async (
  input: HttpDispatchInput,
  deps: HttpDispatchDeps,
): Promise<OcrEngineResult | null> => {
  if (!deps.serviceUrl) return null;
  if (breaker.openUntil > Date.now()) return null; // circuit open — degrade immediately

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const res = await fetch(`${deps.serviceUrl.replace(/\/+$/, '')}/ocr/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ storageKey: input.storageKey, mime: input.mime, ocrJobId: input.ocrJobId }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`handwriting service HTTP ${res.status}`);
    const data = (await res.json()) as ExtractResponse;
    breaker.failures = 0;
    breaker.openUntil = 0;
    const overall = data.overallConfidence ?? 0;
    const drafts: OcrEngineDraft[] = (data.drafts ?? []).map((d) => ({
      position: d.position,
      text: d.text,
      detectedType: d.detectedType ?? 'DESCRIPTIVE',
      options: d.options,
      confidence: d.confidence ?? overall,
    }));
    return { providerUsed: data.providerUsed || 'handwriting-http', overallConfidence: overall, drafts };
  } catch {
    recordFailure();
    return null;
  } finally {
    clearTimeout(timer);
  }
};
