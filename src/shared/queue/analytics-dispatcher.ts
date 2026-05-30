import type { AnalyticsAggregateJob } from './analytics-queue.service';

/**
 * DI token + interface for the analytics dispatch seam (mirrors OCR_DISPATCHER).
 * Resolves to the BullMQ producer (QUEUE_DRIVER=redis) or the in-process
 * dispatcher (QUEUE_DRIVER=inline). Callers depend on this, never the concrete
 * queue service, so the delivery mechanism is env-selected.
 */
export const ANALYTICS_DISPATCHER = Symbol('ANALYTICS_DISPATCHER');

export interface IAnalyticsDispatcher {
  /** Schedule per-attempt analytics aggregation; returns without awaiting it. */
  enqueue(job: AnalyticsAggregateJob): Promise<string>;
}
