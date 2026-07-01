/*
 * Structural Validator — Node↔Python (localhost) client.
 *
 * REUSES the EXISTING internal Python sidecar (the Document Cleanup Engine on localhost:8002, same
 * service as cleanup-http.ts). It adds NO new architecture / service / port / deployment — it calls a
 * new `/validate-structure` route on that already-running engine.
 *
 * Python is a STRUCTURAL VALIDATOR only (CV, no OCR): given a FINAL crop image it reports whether the
 * crop is a COMPLETE question (content not cut at the edge, options present or a diagram, not split
 * across a column). Node owns OCR, storage, question number/text/options — Python never decides those.
 *
 * Hardened exactly like cleanup-http.ts: AbortController timeout + a tiny circuit breaker. ANY failure
 * / disabled flag / no URL ⇒ null, and the caller DEGRADES to the Node-side completeness validator
 * (validateCompleteness). A structure-validator problem can never stall or block an OCR job.
 */
export interface StructureSettings {
  enabled: boolean;
  serviceUrl: string | null;
  timeoutMs: number;
}

/** Opt-in. Reuses the SAME sidecar URL as the cleanup engine (CLEANUP_ENGINE_URL, localhost:8002). */
export const readStructureSettings = (): StructureSettings => ({
  enabled: /^(1|true|yes|on)$/i.test(process.env.STRUCTURE_VALIDATOR_ENABLED ?? ''),
  serviceUrl: process.env.STRUCTURE_VALIDATOR_URL || process.env.CLEANUP_ENGINE_URL || null,
  timeoutMs: Number(process.env.STRUCTURE_VALIDATOR_TIMEOUT_MS) || 20_000,
});

const THRESHOLD = Number(process.env.STRUCTURE_BREAKER_THRESHOLD) || 3;
const COOLDOWN_MS = Number(process.env.STRUCTURE_BREAKER_COOLDOWN_MS) || 30_000;
const breaker = { failures: 0, openUntil: 0 };
export const resetStructureBreaker = (): void => { breaker.failures = 0; breaker.openUntil = 0; };
const recordFailure = (): void => {
  breaker.failures += 1;
  if (breaker.failures >= THRESHOLD) breaker.openUntil = Date.now() + COOLDOWN_MS;
};

export interface StructureReport {
  /** true = complete crop, false = incomplete (route to review), null = unknown (CV stack absent ⇒ degrade). */
  complete: boolean | null;
  edgeCutTop?: boolean;
  edgeCutBottom?: boolean;
  hasDiagram?: boolean;
  hasTable?: boolean;
  textRows?: number;
  crossColumnGutter?: boolean;
  reason?: string;
}

export interface ValidateStructureInput {
  cropStorageKey: string;
  mime?: string;
  isMcq: boolean;
  optionCount: number;
}

/**
 * POST a crop to the Python /validate-structure route. Returns the structure report, or null on any
 * failure / circuit-open / disabled / no URL — in which case the caller keeps its own (Node) verdict.
 */
export const validateStructureHttp = async (
  input: ValidateStructureInput,
  deps: { serviceUrl: string | null; timeoutMs: number },
): Promise<StructureReport | null> => {
  if (!deps.serviceUrl) return null;
  if (breaker.openUntil > Date.now()) return null; // circuit open — degrade immediately
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const res = await fetch(`${deps.serviceUrl.replace(/\/+$/, '')}/validate-structure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cropStorageKey: input.cropStorageKey,
        mime: input.mime,
        isMcq: input.isMcq,
        optionCount: input.optionCount,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`structure validator HTTP ${res.status}`);
    breaker.failures = 0;
    breaker.openUntil = 0;
    return (await res.json()) as StructureReport;
  } catch {
    recordFailure();
    return null;
  } finally {
    clearTimeout(timer);
  }
};
