/*
 * Document Cleanup ORCHESTRATOR — runs the Python /cleanup engine OFF the OCR
 * critical path.
 *
 * Why this exists: cleanup used to run synchronously BEFORE OCR extraction and
 * block it (measured: a 19-page scan stalled OCR for the full 120s timeout while
 * the Python CV pass — ~228s — never finished in time, so the result was always
 * discarded). OCR must NEVER wait for Python. This module starts cleanup as a
 * single-flight background task: OCR extracts the ORIGINAL bytes immediately, and
 * a cleanup that succeeds in time overwrites the stored object for SUBSEQUENT runs.
 *
 * Guarantees:
 *   - single execution per uploadId (no parallel / duplicate cleanups)
 *   - hard 15s cap (CleanupSettings.timeoutMs) — never blocks, never zombies
 *     (the HTTP call is AbortController-bounded; nothing is spawned)
 *   - best-effort: disabled / dead / circuit-open / timeout / any error ⇒ the
 *     original bytes are kept and OCR is unaffected
 *   - explicit lifecycle logging: [cleanup] started|completed|skipped|timed_out|failed
 *     — a result is NEVER silently discarded.
 */
import {
  CleanupOwner,
  decideCleanupOwner,
  dispatchCleanupHttp,
  readCleanupSettings,
} from './cleanup-http';

export type CleanupState = 'NOT_STARTED' | 'RUNNING' | 'COMPLETED' | 'SKIPPED' | 'FAILED';

// Single-flight guard, keyed by uploadId. In-process is sufficient: OCR runs
// in-process (QUEUE_DRIVER=inline) so one upload is only ever cleaned by one
// process. RUNNING/COMPLETED block a re-start; SKIPPED/FAILED allow a later
// OCR attempt to retry once (still single-flight — never concurrent).
const states = new Map<string, CleanupState>();

export const getCleanupState = (uploadId: string): CleanupState =>
  states.get(uploadId) ?? 'NOT_STARTED';

/** Test/diagnostic helper — clear the guard. */
export const resetCleanupStates = (): void => states.clear();

export interface BackgroundCleanupInput {
  uploadId: string;
  ocrJobId: string;
  storageKey: string;
  /** Original document bytes (already in memory) — used ONLY to classify owner. */
  bytes: Buffer;
  contentType?: string;
}

export interface BackgroundCleanupDeps {
  putObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
}

/**
 * Start cleanup in the background and return IMMEDIATELY (does not await). The
 * caller (OCR runner) proceeds straight to extraction on the original bytes.
 */
export const startBackgroundCleanup = (
  input: BackgroundCleanupInput,
  deps: BackgroundCleanupDeps,
): void => {
  const log = (m: string): void => deps.logger?.log(m);
  const warn = (m: string): void => deps.logger?.warn(m);
  const tag = `upload=${input.uploadId} job=${input.ocrJobId}`;

  const current = states.get(input.uploadId);
  if (current === 'RUNNING' || current === 'COMPLETED') {
    log(`[cleanup] skipped ${tag} reason=already-${current.toLowerCase()}`);
    return;
  }

  const settings = readCleanupSettings();
  if (!settings.enabled || !settings.serviceUrl) {
    states.set(input.uploadId, 'SKIPPED');
    log(`[cleanup] skipped ${tag} reason=disabled-or-no-url`);
    return;
  }

  states.set(input.uploadId, 'RUNNING');
  log(`[cleanup] started ${tag} timeoutMs=${settings.timeoutMs}`);

  // Detached, but fully controlled: a single AbortController-bounded HTTP call.
  // Errors are swallowed here so they can NEVER surface on the OCR path.
  void (async (): Promise<void> => {
    const t0 = Date.now();
    try {
      let owner: CleanupOwner;
      try {
        owner = await decideCleanupOwner(input.bytes, input.contentType, input.storageKey);
      } catch {
        states.set(input.uploadId, 'SKIPPED');
        log(`[cleanup] skipped ${tag} reason=unclassifiable +${Date.now() - t0}ms`);
        return;
      }
      if (owner !== 'python' && owner !== 'python+sharp') {
        states.set(input.uploadId, 'SKIPPED');
        log(`[cleanup] skipped ${tag} reason=owner-${owner} +${Date.now() - t0}ms`);
        return;
      }

      const res = await dispatchCleanupHttp(
        {
          ocrJobId: input.ocrJobId,
          storageKey: input.storageKey,
          mime: input.contentType || 'application/pdf',
          owner,
        },
        { serviceUrl: settings.serviceUrl!, timeoutMs: settings.timeoutMs },
      );
      const dur = Date.now() - t0;

      if (res === null) {
        // null ⇒ abort(timeout) | circuit-open | HTTP error. Classify timeout by
        // elapsed time so the log distinguishes timed_out from failed.
        const timedOut = dur >= settings.timeoutMs * 0.9;
        states.set(input.uploadId, timedOut ? 'SKIPPED' : 'FAILED');
        log(
          `[cleanup] ${timedOut ? 'timed_out' : 'failed'} ${tag} +${dur}ms ` +
            `(original bytes kept; OCR unaffected)`,
        );
        return;
      }

      if (res.changed && res.bytes) {
        await deps.putObject(input.storageKey, res.bytes, input.contentType || 'application/pdf');
        states.set(input.uploadId, 'COMPLETED');
        log(
          `[cleanup] completed ${tag} +${dur}ms changed=true ` +
            `bytes=${res.bytes.length} (stored for subsequent runs)`,
        );
      } else {
        states.set(input.uploadId, 'COMPLETED');
        log(`[cleanup] completed ${tag} +${dur}ms changed=false (safe no-op)`);
      }
    } catch (err) {
      states.set(input.uploadId, 'FAILED');
      warn(
        `[cleanup] failed ${tag} +${Date.now() - t0}ms ` +
          `${err instanceof Error ? err.message : String(err)} (original bytes kept)`,
      );
    }
  })();
};
