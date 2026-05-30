/**
 * Lightweight stage timing helper. Use inside multi-phase use cases to log
 * per-step deltas and total elapsed time without leaking timing across
 * unrelated logs.
 *
 *   const t = new StageTimer();
 *   await thing1(); this.logger.log(`[1/3] ${t.mark()}`);
 *   await thing2(); this.logger.log(`[2/3] ${t.mark()}`);
 *
 * Output: "[1/3] +42ms total=42ms" then "[2/3] +118ms total=160ms".
 */
export class StageTimer {
  private readonly start = Date.now();
  private last = this.start;

  /** Format ms-since-last-call + cumulative since constructor. */
  mark(): string {
    const now = Date.now();
    const dt = now - this.last;
    const total = now - this.start;
    this.last = now;
    return `+${dt}ms total=${total}ms`;
  }

  /** Just the total elapsed since constructor (for the closing log). */
  total(): number {
    return Date.now() - this.start;
  }

  /** "Xms total" — for use in summary lines. */
  totalLabel(): string {
    return `${this.total()}ms total`;
  }
}
