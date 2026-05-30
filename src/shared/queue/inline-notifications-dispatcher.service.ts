import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { INotificationsDispatcher } from './notifications-dispatcher';
import { DispatchPendingNotificationsUseCase } from '../../modules/notifications/use-cases/dispatch-pending-notifications.use-case';

/**
 * QUEUE_DRIVER=inline notifications backend: runs the dispatch pass IN-PROCESS,
 * no Redis. The cron calls enqueueDispatch() every 30s; we run the same
 * DispatchPendingNotificationsUseCase the BullMQ worker would, fire-and-forget,
 * with an overlap guard (a pass picks ALL pending rows, so skipping a tick while
 * one is in flight is harmless — exactly the single-consumer guarantee the
 * BullMQ worker provided with concurrency 1 + bucket dedupe).
 *
 * The use-case is resolved lazily via ModuleRef so this infra service has no
 * construct-time dependency on NotificationsModule.
 */
@Injectable()
export class InlineNotificationsDispatcher implements INotificationsDispatcher {
  private readonly logger = new Logger(InlineNotificationsDispatcher.name);
  private useCase: DispatchPendingNotificationsUseCase | null = null;
  private running = false;

  constructor(private readonly moduleRef: ModuleRef) {}

  private getUseCase(): DispatchPendingNotificationsUseCase {
    if (!this.useCase) {
      this.useCase = this.moduleRef.get<DispatchPendingNotificationsUseCase>(
        DispatchPendingNotificationsUseCase,
        { strict: false },
      );
    }
    return this.useCase;
  }

  enqueueDispatch(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.running = true;
    const uc = this.getUseCase();
    void uc
      .execute()
      .then((r) => {
        if (r.picked > 0) {
          this.logger.log(`Inline dispatch: picked=${r.picked} sent=${r.sent} failed=${r.failed}`);
        }
      })
      .catch((err) =>
        this.logger.error(
          `Inline notifications dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      )
      .finally(() => {
        this.running = false;
      });
    return Promise.resolve();
  }
}
