import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Inject } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { queueConfig } from '../config/queue.config';
import { createRedisConnection } from '../queue/bullmq.config';
import { OcrExtractJob } from '../queue/ocr-queue.service';
import { shutdownTesseract } from '../ocr-engine/ocr-engine';
import { OcrJobRunner } from './ocr-job-runner.service';

/**
 * In-process BullMQ OCR consumer for QUEUE_DRIVER=redis. Activates ONLY when the
 * driver is 'redis' AND WORKER_MODE is 'both' or 'worker' (default 'api' = inert,
 * an external worker drains the queue). When QUEUE_DRIVER=inline it is fully
 * inert — OCR runs via InlineOcrDispatcher with no Redis.
 *
 * The actual job body now lives in OcrJobRunner (shared with InlineOcrDispatcher),
 * so this class is just the BullMQ transport: own Redis connection, a single
 * Worker on the OCR queue, concurrency 1, graceful onModuleDestroy. Behaviour on
 * the redis path is unchanged.
 */
@Injectable()
export class OcrProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OcrProcessor.name);
  private connection?: Redis;
  private worker?: Worker<OcrExtractJob>;

  constructor(
    @Inject(queueConfig.KEY) private readonly cfg: ConfigType<typeof queueConfig>,
    private readonly runner: OcrJobRunner,
  ) {}

  onModuleInit(): void {
    if (this.cfg.queueDriver === 'inline') {
      this.logger.log(
        'BullMQ OCR worker disabled (QUEUE_DRIVER=inline); OCR runs in-process via InlineOcrDispatcher — no Redis.',
      );
      return;
    }

    if (this.cfg.workerMode === 'api') {
      this.logger.log(
        'In-process OCR consumer disabled (WORKER_MODE=api); an external worker must drain the queue.',
      );
      return;
    }

    this.connection = createRedisConnection(this.cfg.redisUrl);
    this.worker = new Worker<OcrExtractJob>(
      this.cfg.ocrQueueName,
      async (job) => {
        // Rethrow so BullMQ applies its retry/backoff after the upload is
        // marked FAILED — preserving the original worker semantics exactly.
        await this.runner.run(job.data, {
          jobLabel: String(job.id ?? job.data.ocrJobId),
          rethrow: true,
        });
      },
      { connection: this.connection, concurrency: 1 },
    );

    this.worker.on('failed', (job, err) =>
      this.logger.error(`OCR job ${job?.id} failed: ${err.message}`),
    );
    this.logger.log(
      `OcrProcessor consuming "${this.cfg.ocrQueueName}" in-process (WORKER_MODE=${this.cfg.workerMode}, concurrency=1)`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) await this.worker.close();
    await shutdownTesseract();
    if (this.connection) await this.connection.quit();
  }
}
