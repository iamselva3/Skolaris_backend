import { RoutingMetricsService } from './routing-metrics.service';

describe('RoutingMetricsService', () => {
  it('counts outcomes + reasons and derives total / routeRate', () => {
    const m = new RoutingMetricsService();
    m.record('kept_node');
    m.record('routed_queue', 'score_threshold');
    m.record('routed_http', 'near_empty');
    m.record('degraded', 'score_threshold');

    const s = m.snapshot();
    expect(s.kept_node).toBe(1);
    expect(s.routed_queue).toBe(1);
    expect(s.routed_http).toBe(1);
    expect(s.degraded).toBe(1);
    expect(s.total).toBe(4);
    expect(s.routeRate).toBeCloseTo(0.5); // (routed_queue + routed_http) / total
    expect((s.byReason as Record<string, number>).score_threshold).toBe(2);
    expect(s.lastDecisionAt).not.toBeNull();
  });

  it('starts empty', () => {
    const s = new RoutingMetricsService().snapshot();
    expect(s.total).toBe(0);
    expect(s.routeRate).toBe(0);
    expect(s.lastDecisionAt).toBeNull();
  });
});
