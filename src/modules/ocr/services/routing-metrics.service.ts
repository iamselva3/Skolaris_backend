import { Injectable } from '@nestjs/common';

export type RoutingOutcomeKind = 'kept_node' | 'routed_queue' | 'routed_http' | 'degraded';

/**
 * In-memory, per-process counters for handwriting-routing observability
 * (exposed via GET /ocr/ops). Complements the structured `[ocr-routing]` logs:
 * the logs are the per-decision audit trail; these are the live rollups an
 * operator dashboard polls. Reset on process restart — not a persistent store.
 */
@Injectable()
export class RoutingMetricsService {
  private readonly counters: Record<RoutingOutcomeKind, number> = {
    kept_node: 0,
    routed_queue: 0,
    routed_http: 0,
    degraded: 0,
  };
  private readonly byReason: Record<string, number> = {};
  private lastDecisionAt: string | null = null;

  record(kind: RoutingOutcomeKind, reason?: string): void {
    this.counters[kind] += 1;
    if (reason) this.byReason[reason] = (this.byReason[reason] ?? 0) + 1;
    this.lastDecisionAt = new Date().toISOString();
  }

  snapshot(): Record<string, unknown> {
    const total = Object.values(this.counters).reduce((a, b) => a + b, 0);
    const routed = this.counters.routed_queue + this.counters.routed_http;
    return {
      ...this.counters,
      total,
      routeRate: total === 0 ? 0 : Math.round((routed / total) * 1000) / 1000,
      byReason: { ...this.byReason },
      lastDecisionAt: this.lastDecisionAt,
    };
  }
}
