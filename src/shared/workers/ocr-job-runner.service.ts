import { Inject, Injectable, Logger } from '@nestjs/common';
import { resetTesseract, type OcrEngineResult } from '../ocr-engine/ocr-engine';
import { readHandwritingSettings, resolveDrafts } from '../ocr-engine/resolve-drafts';
import { dispatchHandwritingHttp } from '../ocr-engine/handwriting-http';
import { IObjectStorage, OBJECT_STORAGE } from '../storage/object-storage.interface';
import { OcrExtractJob } from '../queue/ocr-queue.service';
import { OcrHandwritingQueueService } from '../queue/ocr-handwriting-queue.service';
import { HandleOcrCallbackUseCase } from '../../modules/ocr/use-cases/handle-ocr-callback.use-case';
import { RoutingMetricsService } from '../../modules/ocr/services/routing-metrics.service';
import {
  IOcrJobRepository,
  OCR_JOB_REPOSITORY,
} from '../../modules/ocr/repositories/ocr-job.repository';
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
    @Inject(OCR_JOB_REPOSITORY) private readonly ocrJobs: IOcrJobRepository,
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
        sourcePageNumber: d.sourcePageNumber,
        spanPageStart: d.spanPageStart,
        spanPageEnd: d.spanPageEnd,
        solutionText: d.solutionText,
        questionSnapshotKey: d.questionSnapshotKey,
        optionCount: d.optionCount,
        questionNumber: d.questionNumber ?? undefined,
        invalidCrop: d.invalidCrop ?? undefined,
        sourceCoordinates: d.sourceCoordinates,
        // Slice 2.3 — figure crops attached to this draft (storageKey already
        // points at R2; OcrDraftFigure rows are written in the callback).
        figures: d.figures?.map((f) => ({
          storageKey: f.storageKey,
          kind: f.kind,
          boundingBox: f.boundingBox,
          caption: f.caption,
        })),
      })),
      pageMetadata: r.pageMetadata as unknown as Array<Record<string, unknown>> | undefined,
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
    this.logger.log(`[ocr-timing] job_started job=${label} t=${new Date(t0).toISOString()}`);
    try {
      // Read bytes DIRECTLY from the active storage adapter (R2/S3) via DI —
      // no HTTP round-trip to our own read-proxy and no GCS_* env resolution,
      // so the legacy localhost:4443 fallback can never occur on this path.
      const { body, contentType } = await this.storage.getObject(storageKey);
      this.logger.log(
        `[ocr-timing] storage_read_complete job=${label} +${Date.now() - t0}ms bytes=${body.length}`,
      );
      const settings = readHandwritingSettings();
      // Phase 2 — initialize live progress: stage OCR_PROCESSING, processed=0.
      // Subsequent updates land via the onPageComplete callback below.
      await this.ocrJobs
        .updateProgress(ocrJobId, { stage: 'OCR_PROCESSING', processed: 0, total: 0 })
        .catch(() => undefined);
      // Slice 2.3 + Phase 2: hand the storage adapter to the engine so figure
      // crops detected during OCR can be uploaded directly (no client
      // round-trip), AND hand a progress callback so the UI can show per-page
      // completion while the OCR loop runs.
      const outcome = await resolveDrafts(body, contentType, storageKey, {
        settings,
        putObject: (key, payload, ct) => this.storage.putObject(key, payload, ct),
        figureKeyPrefix: `tenants/${job.tenantId}/ocr-figures/${ocrJobId}`,
        onPageComplete: async (processed, total) => {
          await this.ocrJobs
            .updateProgress(ocrJobId, {
              stage: 'OCR_PROCESSING',
              processed,
              total,
              currentPage: processed,
            })
            .catch(() => undefined);
        },
      });
      this.logger.log(
        `[ocr-timing] extract_complete job=${label} +${Date.now() - t0}ms outcome=${outcome.kind}`,
      );

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

      const persistT0 = Date.now();
      this.logger.log(`[ocr-timing] persist_started job=${label} +${persistT0 - t0}ms`);
      await this.persist(ocrJobId, outcome.result);
      this.logger.log(
        `[ocr-timing] persist_complete job=${label} +${Date.now() - t0}ms persist_dur=${Date.now() - persistT0}ms`,
      );
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
