import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { IAnalyticsDispatcher } from './analytics-dispatcher';
import { AnalyticsAggregateJob } from './analytics-queue.service';
import { AnalyticsJobRunner } from '../workers/analytics-job-runner.service';

/**
 * QUEUE_DRIVER=inline analytics backend: runs aggregation IN-PROCESS, no Redis.
 * Fire-and-forget on a serial promise-chain (concurrency 1) so callers
 * (grade-attempt, close-exam, crons) are never blocked and DB recompute work
 * never runs reentrantly. AnalyticsJobRunner is resolved lazily via ModuleRef so
 * this infra service carries no construct-time dependency on AnalyticsModule.
 */
@Injectable()
export class InlineAnalyticsDispatcher implements IAnalyticsDispatcher {
  private readonly logger = new Logger(InlineAnalyticsDispatcher.name);
  private runner: AnalyticsJobRunner | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly moduleRef: ModuleRef) {}

  private getRunner(): AnalyticsJobRunner {
    if (!this.runner) {
      this.runner = this.moduleRef.get<AnalyticsJobRunner>(AnalyticsJobRunner, { strict: false });
    }
    return this.runner;
  }

  enqueue(job: AnalyticsAggregateJob): Promise<string> {
    const runner = this.getRunner();
    this.tail = this.tail.then(() =>
      runner.run(job).catch((err) => {
        this.logger.error(
          `Inline analytics job for attempt ${job.attemptId} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }),
    );
    return Promise.resolve(job.attemptId);
  }
}
