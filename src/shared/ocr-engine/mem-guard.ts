/*
 * Container-aware OCR memory watchdog.
 *
 * A scanned PDF forces the engine to render every page to a large raster, hold
 * them all for the cross-page flat field, and run Tesseract — on a small tier
 * (e.g. Render 512MB) that peak can exceed the container limit and the OS
 * OOM-kills the whole process (the API dies, not just the job). A JS try/catch
 * cannot catch an OS OOM-kill, so the only defence is to NOT allocate past the
 * ceiling: this watchdog reads the WHOLE container's memory usage (cgroup, so it
 * sees Node + Tesseract + the Python sidecar together) at each point where the
 * next step would allocate a lot, and aborts the job cleanly BEFORE the spike.
 *
 * Driver-agnostic (trips whichever process is growing) and a no-op on
 * unconstrained hosts (dev/CI): there the limit falls back to os.totalmem(), so
 * the budget sits far above anything an OCR job reaches and normal jobs never
 * trip it — existing behaviour and tests are unchanged.
 */
import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';

const MB = 1024 * 1024;

/**
 * Raised when the container is too close to its memory ceiling to safely
 * continue. Marked `permanent` so OcrJobRunner FAILS the upload instead of
 * pausing/resuming it — re-attempting the same oversized document on the same
 * tier would only OOM again (and burn all resume attempts).
 */
export class OcrMemoryLimitError extends Error {
  readonly permanent = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'OcrMemoryLimitError';
  }
}

/** Container memory LIMIT in bytes: cgroup v2 (memory.max) → v1 → os.totalmem(). */
const readLimitBytes = (): number => {
  for (const p of [
    '/sys/fs/cgroup/memory.max', // cgroup v2
    '/sys/fs/cgroup/memory/memory.limit_in_bytes', // cgroup v1
  ]) {
    try {
      const raw = readFileSync(p, 'utf8').trim();
      if (raw && raw !== 'max') {
        const n = Number(raw);
        // Ignore the cgroup "unlimited" sentinel (a near-INT64 value) and junk.
        if (Number.isFinite(n) && n > 0 && n < 64 * 1024 * MB) return n;
      }
    } catch {
      /* not this platform / not readable — try the next path */
    }
  }
  return totalmem();
};

/** Current container memory USAGE in bytes: cgroup current → this process RSS. */
const readUsageBytes = (): number => {
  for (const p of [
    '/sys/fs/cgroup/memory.current', // cgroup v2
    '/sys/fs/cgroup/memory/memory.usage_in_bytes', // cgroup v1
  ]) {
    try {
      const n = Number(readFileSync(p, 'utf8').trim());
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
      /* fall through to process RSS */
    }
  }
  return process.memoryUsage().rss;
};

// The limit is fixed for the container's lifetime — read once.
const LIMIT_BYTES = readLimitBytes();

/**
 * Safe memory budget in bytes. Overridable per deployment:
 *   OCR_MEM_BUDGET_MB   — absolute cap (e.g. 410 on a 512MB tier), OR
 *   OCR_MEM_BUDGET_FRAC — fraction of the container limit (default 0.80).
 * The gap between the budget and the real limit is the headroom left for the ONE
 * allocation between the check and the abort, so keep the fraction < ~0.85.
 */
const budgetBytes = (): number => {
  const abs = Number(process.env.OCR_MEM_BUDGET_MB);
  if (Number.isFinite(abs) && abs > 0) return abs * MB;
  const frac = Number(process.env.OCR_MEM_BUDGET_FRAC);
  const f = Number.isFinite(frac) && frac > 0 && frac < 1 ? frac : 0.8;
  return Math.floor(LIMIT_BYTES * f);
};

/**
 * Throw OcrMemoryLimitError if the container is already over its memory budget.
 * Call at each large-allocation boundary (render a page, build the flat field,
 * OCR a page). Set OCR_MEM_GUARD=off to disable entirely.
 */
export const assertOcrMemoryHeadroom = (stage: string): void => {
  if (process.env.OCR_MEM_GUARD === 'off') return;
  const used = readUsageBytes();
  const budget = budgetBytes();
  if (used > budget) {
    throw new OcrMemoryLimitError(
      `OCR aborted at "${stage}": memory ${Math.round(used / MB)}MB exceeds the safe budget ` +
        `${Math.round(budget / MB)}MB (container limit ${Math.round(LIMIT_BYTES / MB)}MB). This ` +
        `document is too large to process on the current memory tier — upgrade to a larger ` +
        `instance (≥1GB) to process documents this size.`,
    );
  }
};
