import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
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

@Injectable()
export class OcrQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OcrQueueService.name);
  private readonly connection: Redis;
  private readonly queue: Queue<OcrExtractJob>;

  constructor(@Inject(queueConfig.KEY) private readonly cfg: ConfigType<typeof queueConfig>) {
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
  }

  async onModuleInit(): Promise<void> {
    this.logger.log(`OCR queue "${this.cfg.ocrQueueName}" ready at ${this.cfg.redisUrl}`);
  }

  async enqueue(job: OcrExtractJob): Promise<string> {
    const added = await this.queue.add('extract', job, {
      jobId: job.ocrJobId, // dedupes accidental double-enqueue
    });
    this.logger.log(`Enqueued OCR job ${added.id} for upload ${job.uploadId}`);
    return added.id ?? job.ocrJobId;
  }

  /**
   * BullMQ exposes the set of currently-connected workers via the heartbeat
   * registry. Used by WorkerAbsenceCron to warn the operator when jobs pile
   * up because no consumer process is running.
   */
  async getConnectedWorkerCount(): Promise<number> {
    const workers = await this.queue.getWorkers();
    return workers.length;
  }

  async getWaitingCount(): Promise<number> {
    return this.queue.getWaitingCount();
  }

  async getActiveCount(): Promise<number> {
    return this.queue.getActiveCount();
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
