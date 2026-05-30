import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { queueConfig } from '../config/queue.config';
import { createRedisConnection } from '../queue/bullmq.config';
import { OcrExtractJob } from '../queue/ocr-queue.service';
import { OcrHandwritingQueueService } from '../queue/ocr-handwriting-queue.service';
import {
  fetchObjectBytes,
  resetTesseract,
  shutdownTesseract,
  type OcrEngineResult,
} from '../ocr-engine/ocr-engine';
import { readHandwritingSettings, resolveDrafts } from '../ocr-engine/resolve-drafts';
import { dispatchHandwritingHttp } from '../ocr-engine/handwriting-http';
import { HandleOcrCallbackUseCase } from '../../modules/ocr/use-cases/handle-ocr-callback.use-case';
import { RoutingMetricsService } from '../../modules/ocr/services/routing-metrics.service';
import { QuestionType } from '../../modules/questions/models/question-type.enum';

/**
 * In-process OCR consumer. Activates ONLY when WORKER_MODE is 'both' or
 * 'worker' (default 'api' = inert, external worker keeps draining the queue),
 * so adding this provider is non-breaking. When active it mirrors
 * AnalyticsProcessor exactly: own Redis connection, a single Worker on the OCR
 * queue, concurrency 1, graceful onModuleDestroy.
 *
 * It reuses the SAME extraction engine as scripts/ocr-worker.ts and persists
 * drafts by calling HandleOcrCallbackUseCase directly — the identical code the
 * HTTP/HMAC callback controller invokes — so the parse → draft →
 * READY_FOR_REVIEW behaviour is byte-identical to the standalone worker, with
 * no loopback HTTP and no HMAC needed on this path.
 */
@Injectable()
export class OcrProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OcrProcessor.name);
  private connection?: Redis;
  private worker?: Worker<OcrExtractJob>;

  constructor(
    @Inject(queueConfig.KEY) private readonly cfg: ConfigType<typeof queueConfig>,
    private readonly handleCallback: HandleOcrCallbackUseCase,
    private readonly handwritingQueue: OcrHandwritingQueueService,
    private readonly metrics: RoutingMetricsService,
  ) {}

  /** Persist an engine result via the shared callback use-case (source-blind). */
  private persist(ocrJobId: string, r: OcrEngineResult): Promise<unknown> {
    return this.handleCallback.execute({
      ocrJobId,
      providerUsed: r.providerUsed,
      overallConfidence: r.overallConfidence,
      drafts: r.drafts.map((d) => ({
        position: d.position,
        text: d.text,
        detectedType: d.detectedType as QuestionType,
        options: d.options,
        confidence: d.confidence,
      })),
    });
  }

  onModuleInit(): void {
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
        const { ocrJobId, uploadId, storageKey } = job.data;
        const t0 = Date.now();
        this.logger.log(`OCR job=${job.id} ocrJob=${ocrJobId} upload=${uploadId} accepted`);
        try {
          const { bytes, mime } = await fetchObjectBytes(storageKey);
          const settings = readHandwritingSettings();
          const outcome = await resolveDrafts(bytes, mime, storageKey, { settings });

          // Handwriting fallback (flag ON + classifier routes).
          if (outcome.kind === 'route') {
            if (settings.dispatch === 'http') {
              // Inline-HTTP: call the Python service synchronously; on any
              // failure DEGRADE to the Node result so the upload never stalls.
              const py = await dispatchHandwritingHttp(
                { ocrJobId, storageKey, mime },
                { serviceUrl: settings.serviceUrl, timeoutMs: settings.timeoutMs },
              );
              if (py) {
                await this.persist(ocrJobId, py);
                this.metrics.record('routed_http', outcome.decision.reason);
                this.logger.log(
                  `OCR job=${job.id} handwriting via HTTP → ${py.drafts.length} draft(s) | total=${Date.now() - t0}ms`,
                );
                return;
              }
              await this.persist(ocrJobId, outcome.nodeResult);
              this.metrics.record('degraded', outcome.decision.reason);
              this.logger.warn(
                `OCR job=${job.id} handwriting HTTP unavailable; degraded to Node result (${outcome.decision.reason})`,
              );
              return;
            }
            // Queue mode (default): hand off + SUPPRESS this callback so exactly
            // one component writes the terminal result.
            await this.handwritingQueue.enqueue(job.data);
            this.metrics.record('routed_queue', outcome.decision.reason);
            this.logger.log(
              `OCR job=${job.id} routed to handwriting queue (${outcome.decision.reason}); Node callback suppressed`,
            );
            return;
          }

          await this.persist(ocrJobId, outcome.result);
          this.metrics.record('kept_node');
          this.logger.log(
            `OCR job=${job.id} delivered ${outcome.result.drafts.length} draft(s) | total=${Date.now() - t0}ms provider=${outcome.result.providerUsed}`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`OCR job=${job.id} FAILED: ${message}`);
          // Flip the upload to FAILED via the same use-case, then rethrow so
          // BullMQ applies its retry/backoff policy.
          await this.handleCallback
            .execute({
              ocrJobId,
              providerUsed: 'tesseract',
              overallConfidence: 0,
              drafts: [],
              errorMessage: message.slice(0, 500),
            })
            .catch(() => undefined);
          // A Tesseract worker-thread fault can poison the singleton — drop it
          // so the next job re-initialises cleanly. Never crash the API process.
          resetTesseract();
          throw err;
        }
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
