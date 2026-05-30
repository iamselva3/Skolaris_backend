import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { queueConfig } from '../config/queue.config';
import { createRedisConnection } from './bullmq.config';
import { OcrExtractJob } from './ocr-queue.service';

/**
 * Producer for the SECONDARY handwriting queue (default 'ocr.handwriting'),
 * consumed by the optional Python handwriting microservice. Reuses the EXISTING
 * OcrExtractJob payload verbatim.
 *
 * LAZY: the Redis connection + Queue are created on first enqueue(), so when the
 * handwriting fallback is disabled (the default) this service adds NO Redis
 * connection and has zero runtime footprint — preserving today's behaviour.
 */
@Injectable()
export class OcrHandwritingQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(OcrHandwritingQueueService.name);
  private connection: Redis | null = null;
  private queue: Queue<OcrExtractJob> | null = null;

  constructor(@Inject(queueConfig.KEY) private readonly cfg: ConfigType<typeof queueConfig>) {}

  private ensureQueue(): Queue<OcrExtractJob> {
    if (!this.queue) {
      this.connection = createRedisConnection(this.cfg.redisUrl);
      this.queue = new Queue<OcrExtractJob>(this.cfg.handwritingQueueName, {
        connection: this.connection,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
          removeOnFail: { age: 7 * 24 * 60 * 60 },
        },
      });
      this.logger.log(`Handwriting OCR queue "${this.cfg.handwritingQueueName}" initialized`);
    }
    return this.queue;
  }

  async enqueue(job: OcrExtractJob): Promise<string> {
    const added = await this.ensureQueue().add('extract', job, {
      jobId: job.ocrJobId, // own namespace; dedupes accidental double-enqueue
    });
    this.logger.log(`Enqueued handwriting OCR job ${added.id} for upload ${job.uploadId}`);
    return added.id ?? job.ocrJobId;
  }

  async getConnectedWorkerCount(): Promise<number> {
    if (!this.queue) return 0;
    return (await this.queue.getWorkers()).length;
  }

  async getWaitingCount(): Promise<number> {
    if (!this.queue) return 0;
    return this.queue.getWaitingCount();
  }

  async getActiveCount(): Promise<number> {
    if (!this.queue) return 0;
    return this.queue.getActiveCount();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.queue) await this.queue.close();
    if (this.connection) await this.connection.quit();
  }
}
