import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  resetTesseract,
  type OcrEngineResult,
} from '../ocr-engine/ocr-engine';
import { readHandwritingSettings, resolveDrafts } from '../ocr-engine/resolve-drafts';
import { dispatchHandwritingHttp } from '../ocr-engine/handwriting-http';
import { IObjectStorage, OBJECT_STORAGE } from '../storage/object-storage.interface';
import { OcrExtractJob } from '../queue/ocr-queue.service';
import { OcrHandwritingQueueService } from '../queue/ocr-handwriting-queue.service';
import { HandleOcrCallbackUseCase } from '../../modules/ocr/use-cases/handle-ocr-callback.use-case';
import { RoutingMetricsService } from '../../modules/ocr/services/routing-metrics.service';
import { QuestionType } from '../../modules/questions/models/question-type.enum';

/**
 * The OCR job body, extracted VERBATIM from OcrProcessor's BullMQ worker
 * callback so a single implementation now backs BOTH dispatch backends:
 *   - the BullMQ worker (OcrProcessor, QUEUE_DRIVER=redis) → run(job, {rethrow:true})
 *   - the in-process dispatcher (InlineOcrDispatcher, QUEUE_DRIVER=inline) → run(job)
 *
 * It reads bytes directly from the injected storage adapter (R2/S3), runs the
 * unchanged OCR engine, and persists drafts via HandleOcrCallbackUseCase — the
 * identical code path the HMAC HTTP callback invokes — so the parse → draft →
 * READY_FOR_REVIEW behaviour is byte-identical regardless of dispatch backend.
 *
 * The OCR engine, HandleOcrCallbackUseCase, and draft generation are NOT
 * modified by this extraction.
 */
@Injectable()
export class OcrJobRunner {
  private readonly logger = new Logger(OcrJobRunner.name);

  constructor(
    @Inject(OBJECT_STORAGE) private readonly storage: IObjectStorage,
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

  /**
   * Process one OCR job. Behaviour matches the original worker callback exactly.
   *
   * @param opts.jobLabel  identifier used only in log lines (BullMQ job id for
   *                       the worker path; ocrJobId for the inline path).
   * @param opts.rethrow   when true (BullMQ path), rethrow after marking the
   *                       upload FAILED so BullMQ applies its retry/backoff.
   *                       When false (inline path), the error is swallowed —
   *                       there is no queue to retry, and the upload has already
   *                       been flipped to FAILED for the StuckUploadsCron / UI.
   */
  async run(
    job: OcrExtractJob,
    opts: { jobLabel?: string; rethrow?: boolean } = {},
  ): Promise<void> {
    const { ocrJobId, uploadId, storageKey } = job;
    const label = opts.jobLabel ?? ocrJobId;
    const t0 = Date.now();
    this.logger.log(`OCR job=${label} ocrJob=${ocrJobId} upload=${uploadId} accepted`);
    try {
      // Read bytes DIRECTLY from the active storage adapter (R2/S3) via DI —
      // no HTTP round-trip to our own read-proxy and no GCS_* env resolution,
      // so the legacy localhost:4443 fallback can never occur on this path.
      const { body, contentType } = await this.storage.getObject(storageKey);
      const settings = readHandwritingSettings();
      const outcome = await resolveDrafts(body, contentType, storageKey, { settings });

      // Handwriting fallback (flag ON + classifier routes).
      if (outcome.kind === 'route') {
        if (settings.dispatch === 'http') {
          // Inline-HTTP: call the Python service synchronously; on any
          // failure DEGRADE to the Node result so the upload never stalls.
          const py = await dispatchHandwritingHttp(
            { ocrJobId, storageKey, mime: contentType },
            { serviceUrl: settings.serviceUrl, timeoutMs: settings.timeoutMs },
          );
          if (py) {
            await this.persist(ocrJobId, py);
            this.metrics.record('routed_http', outcome.decision.reason);
            this.logger.log(
              `OCR job=${label} handwriting via HTTP → ${py.drafts.length} draft(s) | total=${Date.now() - t0}ms`,
            );
            return;
          }
          await this.persist(ocrJobId, outcome.nodeResult);
          this.metrics.record('degraded', outcome.decision.reason);
          this.logger.warn(
            `OCR job=${label} handwriting HTTP unavailable; degraded to Node result (${outcome.decision.reason})`,
          );
          return;
        }
        // Queue mode (default): hand off + SUPPRESS this callback so exactly
        // one component writes the terminal result.
        await this.handwritingQueue.enqueue(job);
        this.metrics.record('routed_queue', outcome.decision.reason);
        this.logger.log(
          `OCR job=${label} routed to handwriting queue (${outcome.decision.reason}); Node callback suppressed`,
        );
        return;
      }

      await this.persist(ocrJobId, outcome.result);
      this.metrics.record('kept_node');
      this.logger.log(
        `OCR job=${label} delivered ${outcome.result.drafts.length} draft(s) | total=${Date.now() - t0}ms provider=${outcome.result.providerUsed}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`OCR job=${label} FAILED: ${message}`);
      // Flip the upload to FAILED via the same use-case, then (BullMQ path only)
      // rethrow so BullMQ applies its retry/backoff policy.
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
      // so the next job re-initialises cleanly. Never crash the host process.
      resetTesseract();
      if (opts.rethrow) throw err;
    }
  }
}
