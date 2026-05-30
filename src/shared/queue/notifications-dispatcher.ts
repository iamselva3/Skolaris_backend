/**
 * DI token + interface for the notifications dispatch seam. Resolves to the
 * BullMQ producer (QUEUE_DRIVER=redis) or the in-process dispatcher
 * (QUEUE_DRIVER=inline). The dispatch cron depends on this, never the concrete
 * queue service.
 */
export const NOTIFICATIONS_DISPATCHER = Symbol('NOTIFICATIONS_DISPATCHER');

export interface INotificationsDispatcher {
  /** Trigger a dispatch pass over pending notifications; returns promptly. */
  enqueueDispatch(): Promise<void>;
}
