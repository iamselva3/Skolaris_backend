/*
 * Crop cleaner — Node↔Python (localhost) client.
 *
 * REUSES the EXISTING internal Python sidecar (localhost:8002, same service as cleanup-http.ts /
 * structure-http.ts). It calls the new `/clean-crop` route — NO new architecture / service / port.
 *
 * Python erases a LEADING question-number BADGE (circled / boxed / "NM"-tagged / plain / handwritten)
 * the token-based number strip cannot see, pixel-level + content-safe. This makes EVERY delivered crop
 * content-only regardless of which engine (TS Tesseract OR the Python document engine) built it — so a
 * scanned paper whose crops come from the TS screenshot-first path is cleaned too.
 *
 * Hardened like the sibling clients: AbortController timeout + a tiny circuit breaker. ANY failure /
 * disabled flag / no URL ⇒ null and the caller keeps the ORIGINAL crop (never blocks an OCR job).
 */
export interface CropCleanSettings {
  enabled: boolean;
  serviceUrl: string | null;
  timeoutMs: number;
}

/** Opt-in. Reuses the SAME sidecar URL as the cleanup engine (CLEANUP_ENGINE_URL, localhost:8002). */
export const readCropCleanSettings = (): CropCleanSettings => ({
  enabled: /^(1|true|yes|on)$/i.test(process.env.CROP_CLEAN_ENABLED ?? ''),
  serviceUrl: process.env.CROP_CLEAN_URL || process.env.CLEANUP_ENGINE_URL || null,
  timeoutMs: Number(process.env.CROP_CLEAN_TIMEOUT_MS) || 15_000,
});

const THRESHOLD = Number(process.env.CROP_CLEAN_BREAKER_THRESHOLD) || 3;
const COOLDOWN_MS = Number(process.env.CROP_CLEAN_BREAKER_COOLDOWN_MS) || 30_000;
const breaker = { failures: 0, openUntil: 0 };
export const resetCropCleanBreaker = (): void => { breaker.failures = 0; breaker.openUntil = 0; };
const recordFailure = (): void => {
  breaker.failures += 1;
  if (breaker.failures >= THRESHOLD) breaker.openUntil = Date.now() + COOLDOWN_MS;
};

export interface CropCleanResult {
  /** true = a leading number/badge was whitened (image changed); false = no marker found (unchanged). */
  erased: boolean;
  /** cleaned PNG bytes (only meaningful when erased=true); null when nothing changed / on failure. */
  image: Buffer | null;
}

/**
 * POST a crop's storage key to the Python /clean-crop route. The sidecar fetches the crop (read-proxy),
 * erases a leading number/badge, and returns the cleaned PNG (base64). Node stores it back under the
 * same key. Returns {erased:false,image:null} on any failure / circuit-open / disabled / no URL — the
 * caller then keeps the original crop unchanged. Never throws.
 */
export const cleanCropHttp = async (
  cropStorageKey: string,
  deps: { serviceUrl: string | null; timeoutMs: number },
): Promise<CropCleanResult> => {
  const miss: CropCleanResult = { erased: false, image: null };
  if (!deps.serviceUrl || !cropStorageKey) return miss;
  if (breaker.openUntil > Date.now()) return miss; // circuit open — degrade immediately
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const res = await fetch(`${deps.serviceUrl.replace(/\/+$/, '')}/clean-crop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cropStorageKey }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`crop cleaner HTTP ${res.status}`);
    breaker.failures = 0;
    breaker.openUntil = 0;
    const body = (await res.json()) as { erased?: boolean; imageBase64?: string };
    if (!body.erased || !body.imageBase64) return miss;
    return { erased: true, image: Buffer.from(body.imageBase64, 'base64') };
  } catch {
    recordFailure();
    return miss;
  } finally {
    clearTimeout(timer);
  }
};
