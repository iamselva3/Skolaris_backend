/*
 * Document Cleanup Engine — Node↔Python (localhost) client.
 *
 * Ownership model (decided ONCE, up front — NOT a fallback):
 *   DIGITAL PDF  → 'pdf-lib'      (handled by the pre-dispatch enhancement flow; NOT here)
 *   SCANNED PDF  → 'python'       (Python Cleanup Engine: protect-mask → background cleanup)
 *   IMAGE        → 'python+sharp' (image normalize + Python Cleanup Engine)
 *   else         → 'none'         (bypass → unchanged OCR)
 *
 * The Python service is an INTERNAL localhost sidecar (same architecture as
 * ocr-handwriting): Node POSTs {storageKey, mime, ocrJobId, owner}; Python fetches
 * the bytes via the read-proxy, cleans them WITHOUT ever touching content (protect-
 * mask first), and returns the cleaned file bytes. Node owns storage, so Node
 * persists the result.
 *
 * DI-free + hardened like handwriting-http.ts: an AbortController timeout and a
 * tiny circuit breaker so a slow/dead/disabled service degrades INSTANTLY to the
 * ORIGINAL bytes. ANY failure ⇒ null/keep-original — a cleanup problem can never
 * stall or break an OCR job. Golden Rule: if uncertain, KEEP PIXELS.
 */
import { profilePdf } from '../../modules/document-profiler/pdf-profiler';

export type CleanupOwner = 'pdf-lib' | 'python' | 'python+sharp' | 'none';

export interface CleanupSettings {
  enabled: boolean;
  serviceUrl: string | null;
  timeoutMs: number;
}

/** Read the cleanup feature flags from env (no central config; mirrors the reflow flag). */
export const readCleanupSettings = (): CleanupSettings => ({
  enabled: /^(1|true|yes|on)$/i.test(process.env.CLEANUP_ENGINE_ENABLED ?? ''),
  serviceUrl: process.env.CLEANUP_ENGINE_URL || null,
  // 15s HARD cap (was 120s). Cleanup is best-effort and runs OFF the OCR
  // critical path (see cleanup-orchestrator.ts) — it must never make a client
  // wait minutes. A scanned doc that can't be cleaned in 15s is SKIPPED.
  timeoutMs: Number(process.env.CLEANUP_ENGINE_TIMEOUT_MS) || 15_000,
});

/**
 * Decide which engine OWNS this document — once, from the document itself.
 * Images → python+sharp; SCANNED PDFs → python; DIGITAL PDFs → pdf-lib (handled
 * pre-dispatch, so the runner skips them); unparseable/non-doc → none (bypass).
 */
export const decideCleanupOwner = async (
  bytes: Buffer,
  contentType: string | undefined,
  storageKey: string,
): Promise<CleanupOwner> => {
  const mime = (contentType ?? '').toLowerCase();
  const key = storageKey.toLowerCase();
  const isPdf = mime === 'application/pdf' || key.endsWith('.pdf');
  const isImage = mime.startsWith('image/') || /\.(jpe?g|png|webp|heic)$/.test(key);

  if (isImage && !isPdf) return 'python+sharp';
  if (!isPdf) return 'none';
  try {
    const profile = await profilePdf(bytes);
    // The profiler already biases uncertain → SCANNED, so this also covers mixed/unknown.
    return profile.verdict === 'SCANNED' ? 'python' : 'pdf-lib';
  } catch {
    return 'none'; // unparseable ⇒ don't risk cleanup; send original to OCR.
  }
};

const THRESHOLD = Number(process.env.CLEANUP_BREAKER_THRESHOLD) || 3;
const COOLDOWN_MS = Number(process.env.CLEANUP_BREAKER_COOLDOWN_MS) || 30_000;
const breaker = { failures: 0, openUntil: 0 };

export const getCleanupBreakerState = (): { failures: number; open: boolean; openUntil: number } => ({
  failures: breaker.failures,
  open: breaker.openUntil > Date.now(),
  openUntil: breaker.openUntil,
});
export const resetCleanupBreaker = (): void => {
  breaker.failures = 0;
  breaker.openUntil = 0;
};
const recordFailure = (): void => {
  breaker.failures += 1;
  if (breaker.failures >= THRESHOLD) breaker.openUntil = Date.now() + COOLDOWN_MS;
};

export interface CleanupDispatchInput {
  ocrJobId: string;
  storageKey: string;
  mime: string;
  owner: CleanupOwner;
}
export interface CleanupDispatchDeps {
  serviceUrl: string | null;
  timeoutMs: number;
}
export interface CleanupResult {
  changed: boolean;
  /** Cleaned bytes — present ONLY when changed:true. */
  bytes: Buffer | null;
}

/**
 * POST the document to the Python cleanup service. Returns the cleaned bytes when
 * the engine changed anything, {changed:false} when it safely no-op'd, or null on
 * any failure / circuit-open / no URL (⇒ caller keeps the ORIGINAL bytes).
 *
 * Wire contract:
 *   request : JSON { storageKey, mime, ocrJobId, owner }
 *   response: header `X-Cleanup-Changed: true|false`
 *             when true  → body = cleaned file bytes (application/pdf or image/*)
 *             when false → empty body (caller keeps the original)
 */
export const dispatchCleanupHttp = async (
  input: CleanupDispatchInput,
  deps: CleanupDispatchDeps,
): Promise<CleanupResult | null> => {
  if (!deps.serviceUrl) return null;
  if (breaker.openUntil > Date.now()) return null; // circuit open — degrade immediately

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const res = await fetch(`${deps.serviceUrl.replace(/\/+$/, '')}/cleanup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        storageKey: input.storageKey,
        mime: input.mime,
        ocrJobId: input.ocrJobId,
        owner: input.owner,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`cleanup service HTTP ${res.status}`);
    breaker.failures = 0;
    breaker.openUntil = 0;
    const changed = (res.headers.get('x-cleanup-changed') ?? '').toLowerCase() === 'true';
    if (!changed) return { changed: false, bytes: null };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return { changed: false, bytes: null };
    return { changed: true, bytes: buf };
  } catch {
    recordFailure();
    return null;
  } finally {
    clearTimeout(timer);
  }
};
