import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { queueConfig } from '../config/queue.config';
import { createRedisConnection } from './bullmq.config';

export interface OcrExtractJob {
  ocrJobId: string;
  tenantId: string;
  uploadId: string;
  storageKey: string;
}

export const OCR_QUEUE = Symbol('OCR_QUEUE');

/**
 * BullMQ producer for the OCR extract queue — the 'redis' OcrDispatcher.
 *
 * LAZY: the Redis connection + Queue are created on first enqueue() (or first
 * monitoring read), NOT in the constructor. So when QUEUE_DRIVER=inline this
 * service is instantiated by DI but opens NO Redis connection and has zero
 * runtime footprint — that's what lets the app boot and run OCR without Redis.
 * (Same pattern as OcrHandwritingQueueService.)
 */
@Injectable()
export class OcrQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(OcrQueueService.name);
  private connection: Redis | null = null;
  private queue: Queue<OcrExtractJob> | null = null;

  constructor(@Inject(queueConfig.KEY) private readonly cfg: ConfigType<typeof queueConfig>) {}

  private ensureQueue(): Queue<OcrExtractJob> {
    if (!this.queue) {
      this.connection = createRedisConnection(this.cfg.redisUrl);
      this.queue = new Queue<OcrExtractJob>(this.cfg.ocrQueueName, {
        connection: this.connection,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
          removeOnFail: { age: 7 * 24 * 60 * 60 },
        },
      });
      this.logger.log(`OCR queue "${this.cfg.ocrQueueName}" ready at ${this.cfg.redisUrl}`);
    }
    return this.queue;
  }

  async enqueue(job: OcrExtractJob): Promise<string> {
    const added = await this.ensureQueue().add('extract', job, {
      jobId: job.ocrJobId, // dedupes accidental double-enqueue
    });
    this.logger.log(`Enqueued OCR job ${added.id} for upload ${job.uploadId}`);
    return added.id ?? job.ocrJobId;
  }

  /**
   * BullMQ exposes the set of currently-connected workers via the heartbeat
   * registry. Used by WorkerAbsenceCron to warn the operator when jobs pile
   * up because no consumer process is running. Returns 0 before the queue is
   * first used (e.g. QUEUE_DRIVER=inline) so monitoring stays quiet/healthy.
   */
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
