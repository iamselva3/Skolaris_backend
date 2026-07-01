import { Inject, Injectable, Logger } from '@nestjs/common';
import { reflowPdf } from '../../modules/ocr-preprocess/pdf-reflow';
import { resetTesseract, type OcrEngineResult } from '../ocr-engine/ocr-engine';
import { OcrMemoryLimitError } from '../ocr-engine/mem-guard';
import { readHandwritingSettings, resolveDrafts } from '../ocr-engine/resolve-drafts';
import { dispatchHandwritingHttp } from '../ocr-engine/handwriting-http';
import { startBackgroundCleanup } from '../ocr-engine/cleanup-orchestrator';
import { backgroundRemovalEnabled } from '../ocr-engine/crop-display-clean';
import { cleanCropHttp, readCropCleanSettings } from '../ocr-engine/crop-clean-http';
import { readStructureBuildSettings } from '../ocr-engine/structure-analyze-http';
import { IObjectStorage, OBJECT_STORAGE } from '../storage/object-storage.interface';
import { OcrExtractJob } from '../queue/ocr-queue.service';
import { OcrHandwritingQueueService } from '../queue/ocr-handwriting-queue.service';
import { HandleOcrCallbackUseCase } from '../../modules/ocr/use-cases/handle-ocr-callback.use-case';
import { RoutingMetricsService } from '../../modules/ocr/services/routing-metrics.service';
import {
  OcrAnalysisDeliveryService,
  type DeliverableDraft,
} from '../../modules/ocr-analysis/ocr-analysis-delivery.service';
import {
  IOcrJobRepository,
  OCR_JOB_REPOSITORY,
} from '../../modules/ocr/repositories/ocr-job.repository';
import { QuestionType } from '../../modules/questions/models/question-type.enum';

/**
 * Resumable OCR (P0) kill-switch. ON by default; set OCR_RESUMABLE=0/false/no/off
 * to fall back to the legacy all-or-nothing behaviour (no per-page checkpoints,
 * error → upload FAILED). Shared by the runner, inline dispatcher, recovery
 * service, and StuckUploadsCron so they agree on a single source of truth.
 */
export const isOcrResumableEnabled = (): boolean =>
  !/^(0|false|no|off)$/i.test(process.env.OCR_RESUMABLE ?? '');

/**
 * Single Python Document Engine switch. When ON, an upload is handed WHOLE to Python
 * `/process-document` (OCR router → ownership → crops → N=N=C → deliver) and TS only stores the
 * result (deliver=true) or routes the upload to review (deliver=false). The TS Tesseract OCR pipeline
 * below is NEVER executed in this mode — it remains only as a dormant emergency fallback (gate OFF).
 * Default OFF until the engine passes the regression set; flip with PYTHON_DOCUMENT_ENGINE=1.
 */
export const isPythonDocumentEngineEnabled = (): boolean =>
  /^(1|true|yes|on)$/i.test(process.env.PYTHON_DOCUMENT_ENGINE ?? '');

/**
 * DELIVERY PIPELINE VERSION. A RESULT checkpoint stores the FINAL persisted drafts so a crash mid-
 * persist can resume instantly WITHOUT re-OCR. But that also means a checkpoint written by an OLD
 * delivery pipeline (e.g. the TS-only 149-draft result, before Python analyze owned the crops) would
 * REPLAY verbatim on the next run — so the new Python pipeline "never reaches OCR" and the stale 149
 * keeps appearing. Stamping each checkpoint with this version, and IGNORING a checkpoint whose version
 * differs, invalidates stale results on a deploy: the job re-runs through the CURRENT pipeline. BUMP
 * this whenever the delivery/crop/count behaviour changes so old results are never silently replayed.
 */
export const DELIVERY_VERSION = 4; // v4: HYBRID — TS owns crops, Python validates, background removal OFF

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
    private readonly delivery: OcrAnalysisDeliveryService,
  ) {}

  /**
   * Reconcile the engine's raw segmentation to the analysis-framework's emitted set (ONE source of
   * truth) BEFORE persistence. Runs the full analyzePaper stack over the engine's already-computed
   * per-page words + page images (no re-OCR); drops removed/absorbed drafts and rebuilds merged crops.
   * No artifacts (Paddle / single-image path) ⇒ returns the engine drafts unchanged.
   */
  private async deliverDrafts(
    r: OcrEngineResult,
  ): Promise<{ drafts: OcrEngineResult['drafts']; authority: unknown }> {
    if (!r.analysisPageImages?.length || !r.analysisWordsByPage?.length) {
      // LOUD: Python analyze CANNOT run without per-page words + renders. This is the silent gate that
      // leaves the raw TS drafts (the stale 149) — surface it so an audit sees exactly why Python skipped.
      this.logger.warn(
        `[python-analyze] SKIPPED — engine produced no analysis artifacts ` +
          `(pageImages=${r.analysisPageImages?.length ?? 0}, wordsByPage=${r.analysisWordsByPage?.length ?? 0}); ` +
          `delivering RAW TS drafts (${r.drafts.length}) — Python NOT run. provider=${r.providerUsed}`,
      );
      return { drafts: r.drafts, authority: null };
    }
    try {
      const result = await this.delivery.deliver(
        r.drafts as unknown as import('../../modules/ocr-analysis/ocr-analysis-delivery.service').DeliverableDraft[],
        {
          wordsByPage: r.analysisWordsByPage.map((ws) => ws.map((w) => ({ text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }))),
          pageImages: r.analysisPageImages,
        },
        {
          getObject: async (key) => (await this.storage.getObject(key)).body,
          putObject: (key, body, ct) => this.storage.putObject(key, body, ct),
          figureKeyPrefix: `${(r.drafts[0]?.questionSnapshotKey ?? 'tenants/ocr-figures').split('/question-')[0]}/merged`,
        },
      );
      return { drafts: result.drafts as unknown as OcrEngineResult['drafts'], authority: result.authority ?? null };
    } catch (err) {
      this.logger.warn(`analysis delivery failed (non-fatal, delivering raw): ${err instanceof Error ? err.message : String(err)}`);
      return { drafts: r.drafts, authority: null };
    }
  }

  /**
   * PER-UPLOAD ENGINE-OWNERSHIP BANNER. One deterministic block per upload naming who actually
   * authored the persisted set and whether Python ran/owned it. Reads the SAME runtime gate the
   * delivery path reads (readStructureBuildSettings) — never a stale env snapshot. `executed` means
   * a Python structural call returned a result (authority was built); `route` names which path ran.
   * Expected healthy state: route=process-document, PYTHON_ENGINE_EXECUTED=true, PYTHON_CROP_COUNT>0,
   * PYTHON_DELIVER=true, TS_PERSISTED_COUNT==PYTHON_CROP_COUNT.
   */
  private logEngineOwnership(ctx: {
    ocrJobId: string;
    uploadId: string;
    route: 'process-document' | 'build-document' | 'ts-only';
    provider: string;
    authority: { pyOwnership?: number; pyCrops?: number; deliver?: boolean } | null;
    executed: boolean;
    persistedCount: number;
  }): void {
    const a = ctx.authority ?? null;
    this.logger.log(
      `\n========== OCR ENGINE OWNERSHIP (upload=${ctx.uploadId} job=${ctx.ocrJobId} route=${ctx.route}) ==========\n` +
        `OCR_PROVIDER=${ctx.provider}\n` +
        `PYTHON_BUILD_ENABLED=${readStructureBuildSettings().enabled}\n` +
        `PYTHON_ENGINE_EXECUTED=${ctx.executed}\n` +
        `PYTHON_OWNERSHIP_COUNT=${a?.pyOwnership ?? 0}\n` +
        `PYTHON_CROP_COUNT=${a?.pyCrops ?? 0}\n` +
        `PYTHON_DELIVER=${a?.deliver ?? false}\n` +
        `TS_PERSISTED_COUNT=${ctx.persistedCount}\n` +
        `===================================================================`,
    );
  }

  /**
   * Erase a leading question-number BADGE on the FINAL delivered crops, in storage, before persist.
   * Reuses the Python /clean-crop route (pixel-level, OCR-independent, content-safe). Applies to crops
   * from ANY engine, so a scanned paper whose crops come from the TS screenshot-first path is cleaned
   * too. Gated by CROP_CLEAN_ENABLED. Overwrites each crop under its OWN key, so the persisted
   * questionSnapshotKey points at the cleaned image. Best-effort + bounded concurrency; never throws.
   */
  private async cleanLeadingBadges(
    ocrJobId: string,
    drafts: Array<{ questionSnapshotKey?: string }>,
  ): Promise<void> {
    // HYBRID ARCHITECTURE (2026-06-24): Python is an INTELLIGENCE layer and must NEVER modify image
    // pixels. The /clean-crop route erases the leading number/badge by whitening pixels — that is pixel
    // manipulation, and the question number is now REQUIRED crop content. It is disabled under the same
    // master switch as every other pixel pass (belt-and-suspenders over CROP_CLEAN_ENABLED, default OFF).
    if (!backgroundRemovalEnabled()) return;
    const s = readCropCleanSettings();
    if (!s.enabled || !s.serviceUrl) return;
    const keys = [...new Set(drafts.map((d) => d.questionSnapshotKey).filter((k): k is string => !!k))];
    if (keys.length === 0) return;
    let erased = 0;
    const CONCURRENCY = 6;
    for (let i = 0; i < keys.length; i += CONCURRENCY) {
      await Promise.all(
        keys.slice(i, i + CONCURRENCY).map(async (key) => {
          try {
            const res = await cleanCropHttp(key, { serviceUrl: s.serviceUrl, timeoutMs: s.timeoutMs });
            if (res.erased && res.image) {
              await this.storage.putObject(key, res.image, 'image/png');
              erased += 1;
            }
          } catch {
            /* best-effort: keep the original crop, never block the job */
          }
        }),
      );
    }
    if (erased) this.logger.log(`[crop-clean] job=${ocrJobId} erased leading number/badge on ${erased}/${keys.length} crop(s)`);
  }

  /** Persist an engine result via the shared callback use-case (source-blind). */
  private async persist(ocrJobId: string, r: OcrEngineResult, uploadId = ocrJobId): Promise<unknown> {
    // [ocr-timing] split: deliverDrafts runs the full analysis framework +
    // (optionally) the Python structure validator/analyzer — measure it apart
    // from the terminal DB callback so the breakdown shows analysis vs persist.
    const deliverT0 = Date.now();
    const { drafts, authority } = await this.deliverDrafts(r);
    this.logger.log(
      `[ocr-timing] deliver_complete job=${ocrJobId} deliver_dur=${Date.now() - deliverT0}ms drafts=${drafts.length}`,
    );
    // LEADING NUMBER / BADGE CLEANUP — runs on the FINAL crops of EVERY upload, whichever engine built
    // them (TS screenshot-first OR the Python document engine). A circled/boxed "143 NM"-style badge is
    // not OCR'd as a clean marker, so the token-based strip misses it; the Python /clean-crop route
    // erases it pixel-level (content-safe). Gated (CROP_CLEAN_ENABLED); best-effort — a failure keeps the
    // original crop and never blocks the job.
    await this.cleanLeadingBadges(ocrJobId, drafts as Array<{ questionSnapshotKey?: string }>);
    // PER-UPLOAD OWNERSHIP BANNER (TS-OCR + delivery path). `authority != null` ⇒ Python /build-document
    // ran (delivery.buildPythonCrops handled it); route is build-document. When authority is null the
    // upload was authored entirely by TS (analyze advisory / build off) ⇒ route ts-only.
    const a = (authority ?? null) as { pyOwnership?: number; pyCrops?: number; deliver?: boolean } | null;
    this.logEngineOwnership({
      ocrJobId,
      uploadId,
      route: a ? 'build-document' : 'ts-only',
      provider: r.providerUsed,
      authority: a,
      executed: a != null,
      persistedCount: drafts.length,
    });
    const input = {
      ocrJobId,
      _deliveryVersion: DELIVERY_VERSION, // version-stamp so a stale checkpoint can't replay old results
      providerUsed: r.providerUsed,
      overallConfidence: r.overallConfidence,
      // Python AUTHORITY proof — persisted in OcrJob.rawOutput.authority, served at GET /ocr/jobs/:id/authority.
      authority: (authority ?? undefined) as Record<string, unknown> | undefined,
      drafts: drafts.map((d) => ({
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
    };
    // TRUE RESUME (Option A): checkpoint the FINAL callback input (drafts + crop
    // keys + page metadata) BEFORE the terminal callback. If the process dies
    // during/after persist, the resumed run replays this WITHOUT re-running ocrPdf
    // (no render / flat field / mask / Tesseract / OCR loop). Best-effort; the
    // checkpoint write must never block or fail the persist itself.
    if (isOcrResumableEnabled()) {
      await this.ocrJobs.saveResultCheckpoint(ocrJobId, input).catch(() => undefined);
      this.logger.log(
        `[ocr-timing] result_checkpoint_saved job=${ocrJobId} drafts=${input.drafts.length}`,
      );
    }
    return this.handleCallback.execute(input);
  }

  /**
   * SINGLE PYTHON DOCUMENT ENGINE path. Hand the WHOLE upload to Python /process-document (OCR router →
   * ownership → crops → N=N=C → deliver). Python OWNS the output ONLY when it can CLEANLY deliver
   * (deliver=true): its built+validated crops are stored verbatim (strictly higher accuracy). When
   * deliver=false Python built NO crops, so persisting its set would degrade the UX (crop-less drafts:
   * empty textbox + bare options) — instead we PRESERVE the existing TS behaviour by returning false so
   * the caller falls through to the TS OCR pipeline (proper Visual-Question crops + options → review).
   * Returns true ONLY when Python delivered and was persisted; false when the gate is OFF OR Python
   * could not cleanly deliver (UX-preserving fallback). When ENABLED but the engine is UNAVAILABLE it
   * THROWS so the job retries — an unavailable engine is a transient error, not a clean non-delivery.
   */
  private async runPythonDocumentEngine(job: OcrExtractJob, label: string, t0: number): Promise<boolean> {
    if (!isPythonDocumentEngineEnabled()) return false;
    const { ocrJobId, uploadId, storageKey } = job;
    this.logger.log(
      `\n===================================\nPYTHON DOCUMENT ENGINE ENABLED\nuploadId=${uploadId}\n` +
        `Calling Python /process-document\n===================================`,
    );
    const io = {
      getObject: async (key: string) => (await this.storage.getObject(key)).body,
      putObject: (key: string, body: Buffer, ct: string) => this.storage.putObject(key, body, ct),
      figureKeyPrefix: `tenants/${job.tenantId}/ocr-figures/${ocrJobId}`,
    };
    const out = await this.delivery.deliverPythonDocument(storageKey, ocrJobId, io);
    if (!out) {
      // Enabled but unavailable. NEVER fall back to TS OCR; throw so the job retries / recovers.
      throw new Error('Python Document Engine unavailable — retrying (no TS fallback, no silent continue)');
    }
    const a = out.authority;
    this.logger.log(
      `\n===================================\nPYTHON DOCUMENT ENGINE RESPONSE\nprovider=python-engine\n` +
        `logical=${a.pyLogical}\nownership=${a.pyOwnership}\ncomplete=${a.pyComplete}\ncrop=${a.pyCrops}\n` +
        `delivered=${out.drafts.length}\ndeliver=${out.deliver}\n===================================`,
    );
    // PER-UPLOAD OWNERSHIP BANNER (whole-upload /process-document path). Logged whether or not Python
    // delivers, so a deliver=false fall-through to TS is visible here BEFORE the TS banner in persist().
    this.logEngineOwnership({
      ocrJobId,
      uploadId,
      route: 'process-document',
      provider: 'python-engine',
      authority: a,
      executed: true,
      persistedCount: out.deliver ? out.drafts.length : 0,
    });
    // PRESERVE EXISTING UX (golden rule: Python must not degrade output). Python OWNS the delivered
    // result ONLY when it can CLEANLY deliver (deliver=true) — then its crops are built + validated and
    // the output is strictly better. When deliver=false, Python did NOT build crops (crops=[]), so its
    // drafts carry NO crop image + a placeholder text + bare options ("Question 19 / empty textbox /
    // a b c d") — a regression vs the existing TS screenshot-first Visual-Question output. In that case
    // we KEEP the proven TS behaviour: fall through to the TS OCR pipeline below (proper crop image +
    // options) which routes to review exactly as before. Python only REPLACES the output when its
    // accuracy is proven; it never replaces correct behaviour with a worse one.
    if (!out.deliver) {
      this.logger.warn(
        `OCR job=${label} PYTHON ENGINE deliver=false (logical=${a.pyLogical} complete=${a.pyComplete} ` +
          `crops=${a.pyCrops} degradedPages=${out.degradedPages}) — preserving existing TS crop behaviour ` +
          `(fall back to TS pipeline, route to review) | +${Date.now() - t0}ms`,
      );
      return false; // run() continues to the TS OCR pipeline → proper Visual-Question crops + options
    }
    await this.persistPythonDrafts(ocrJobId, out.drafts, out.authority);
    this.logger.log(
      `OCR job=${label} PYTHON ENGINE complete | delivered=${out.drafts.length} deliver=${out.deliver} ` +
        `degradedPages=${out.degradedPages} routedToReview=${!out.deliver} | total=${Date.now() - t0}ms`,
    );
    return true;
  }

  /** Persist Python-authored drafts via the SAME terminal callback (writes drafts + crop keys, marks
   *  finished, sets the upload READY_FOR_REVIEW). TS stores verbatim — no recount/re-own/re-crop. */
  private async persistPythonDrafts(
    ocrJobId: string,
    drafts: DeliverableDraft[],
    authority: unknown,
  ): Promise<void> {
    const input = {
      ocrJobId,
      _deliveryVersion: DELIVERY_VERSION, // version-stamp so a stale checkpoint can't replay old results
      providerUsed: 'python-engine',
      authority: (authority ?? undefined) as Record<string, unknown> | undefined,
      drafts: drafts.map((d) => ({
        position: d.position,
        text: (d.text ?? '') as string,
        detectedType: d.detectedType as QuestionType,
        options: (d as { options?: unknown }).options as never,
        sourcePageNumber: d.sourcePageNumber ?? undefined,
        spanPageStart: (d as { spanPageStart?: number }).spanPageStart,
        spanPageEnd: (d as { spanPageEnd?: number }).spanPageEnd,
        questionSnapshotKey: d.questionSnapshotKey,
        optionCount: (d as { optionCount?: number }).optionCount,
        questionNumber: d.questionNumber ?? undefined,
        invalidCrop: (d as { invalidCrop?: boolean }).invalidCrop ?? undefined,
        sourceCoordinates: d.sourceCoordinates ?? undefined,
      })),
    };
    if (isOcrResumableEnabled()) {
      await this.ocrJobs.saveResultCheckpoint(ocrJobId, input).catch(() => undefined);
    }
    await this.handleCallback.execute(input);
    await this.ocrJobs.markCompletedStatus(ocrJobId).catch(() => undefined);
  }

  /**
   * TRUE RESUME pre-ocrPdf gate (Option A). If a RESULT checkpoint exists, a prior
   * attempt had already finished OCR + segmentation and only the terminal callback /
   * completion was interrupted (crash/restart/timeout). Replay the (idempotent)
   * callback and complete — WITHOUT reading bytes, opening the PDF, rendering pages,
   * building the flat field / watermark mask, or initialising Tesseract. This is the
   * "resume first → finish immediately" path. Returns true when it handled the job.
   */
  private async finishFromResultCheckpoint(
    ocrJobId: string,
    label: string,
    t0: number,
  ): Promise<boolean> {
    const saved = await this.ocrJobs.loadResultCheckpoint(ocrJobId).catch(() => null);
    if (!saved) return false;
    // STALE-CHECKPOINT GUARD — a checkpoint from an OLDER delivery pipeline must NOT replay (it would
    // serve the old 149 result and bypass the current Python crop/count pipeline). Re-run instead.
    const savedVersion = (saved as { _deliveryVersion?: number })._deliveryVersion;
    if (savedVersion !== DELIVERY_VERSION) {
      this.logger.warn(
        `[checkpoint] job=${label} STALE result checkpoint (v=${savedVersion ?? 'pre-versioning'} ≠ ` +
          `current v=${DELIVERY_VERSION}) — IGNORING it and re-running through the CURRENT Python ` +
          `delivery pipeline (this is what makes the new code reach OCR).`,
      );
      return false;
    }
    this.logger.log(
      `[ocr-timing] result_checkpoint_hit job=${label} — finishing WITHOUT ocrPdf ` +
        `(skip storage read / pdf open / render / flat field / watermark mask / tesseract init / OCR loop)`,
    );
    await this.handleCallback.execute(saved);
    await this.ocrJobs.markCompletedStatus(ocrJobId).catch(() => undefined);
    this.logger.log(
      `OCR job=${label} resumed from RESULT checkpoint — completed | total=${Date.now() - t0}ms`,
    );
    return true;
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
    // Phase boundaries for the end-of-job PHASE SUMMARY (so the slow phase is unambiguous, not guessed
    // from scattered markers). Each is the wall-clock ms AT that boundary, relative to t0; the summary
    // diffs them. 0 ⇒ that phase did not run on this path.
    const phase = { storageReadDone: 0, extractDone: 0, uploadDrainDone: 0 };
    // Resumable OCR (P0): when enabled, this (re)start bumps attemptCount and flips
    // the durable status to PROCESSING; per-page checkpoints let a restart resume
    // from the last completed page instead of page 1.
    const resumable = isOcrResumableEnabled();
    if (resumable) {
      const { attemptCount } = await this.ocrJobs
        .markRunning(ocrJobId)
        .catch(() => ({ attemptCount: 0 }));
      this.logger.log(`OCR job=${label} resumable run (attempt #${attemptCount})`);
    }
    this.logger.log(`OCR job=${label} ocrJob=${ocrJobId} upload=${uploadId} accepted`);
    this.logger.log(`[ocr-timing] job_started job=${label} t=${new Date(t0).toISOString()}`);
    try {
      // TRUE RESUME gate (Option A) — RESUME FIRST, FINISH IMMEDIATELY, OCR ONLY IF
      // WORK REMAINS. Runs BEFORE any byte read / PDF open / render / flat field /
      // mask / Tesseract init. If a result checkpoint exists the job is finished from
      // it and we return; otherwise we fall through to the normal (per-page-resumable)
      // OCR path below.
      if (resumable && (await this.finishFromResultCheckpoint(ocrJobId, label, t0))) {
        return;
      }
      // ONE FLOW (final architecture): TS Tesseract OCR → Python /analyze-document (ALL intelligence:
      // count, ownership, crop boundaries, N=N=C, delivery decision) → TS renders Python's crops → store.
      // There is no engine switching: Tesseract ALWAYS runs as the OCR extractor; Python is the single
      // intelligence authority in the delivery step. (The whole-upload /process-document path is retired
      // and `runPythonDocumentEngine` is left dormant for a follow-up removal commit.)

      // Read bytes DIRECTLY from the active storage adapter (R2/S3) via DI —
      // no HTTP round-trip to our own read-proxy and no GCS_* env resolution,
      // so the legacy localhost:4443 fallback can never occur on this path.
      const { body, contentType } = await this.storage.getObject(storageKey);
      phase.storageReadDone = Date.now() - t0;
      this.logger.log(
        `[ocr-timing] storage_read_complete job=${label} +${phase.storageReadDone}ms bytes=${body.length}`,
      );

      // Layout preprocess (column reflow). This USED to run as a blocking
      // POST /uploads/:id/preprocess between the browser's PUT and complete —
      // it renders the whole PDF to detect/fix true multi-column pages, which
      // for large papers kept the upload screen stuck at "100%" for a minute+
      // before navigation. It is intrinsically async OCR-prep work, so it now
      // runs HERE, inside the already-async OCR job, before extraction.
      //
      // COST: reflowPdf() renders EVERY page (pdf-to-img @ scale 2) purely to
      // detect side-by-side columns, and the OCR engine then renders the same
      // pages AGAIN. For the common single-column paper the reflow is a no-op,
      // so that first render is pure wasted latency that delays the first draft
      // ("OCR starts extracting late / slow"). Side-by-side papers are rare, so
      // the reflow is OPT-IN: default OFF ⇒ one render, extraction starts at its
      // original speed. Set OCR_PREPROCESS_REFLOW=1 (or true) for deployments
      // whose papers are genuinely two-column. Detection/reflow logic and OCR
      // extraction are unchanged — only whether the extra render runs at all.
      const reflowEnabled = /^(1|true|yes|on)$/i.test(process.env.OCR_PREPROCESS_REFLOW ?? '');
      let ocrBody = body;
      const isPdf =
        (contentType ?? '').toLowerCase() === 'application/pdf' ||
        storageKey.toLowerCase().endsWith('.pdf');
      if (reflowEnabled && isPdf) {
        try {
          const reflow = await reflowPdf(body);
          this.logger.log(
            `[ocr-timing] reflow_complete job=${label} +${Date.now() - t0}ms pages=${reflow.pageCount} reflowed=${reflow.reflowedPages}`,
          );
          if (reflow.changed && reflow.pdf) {
            // Rewrite the stored object so any downstream reader (and a retry of
            // this job) sees the reflowed bytes — same end state the old
            // preprocess step produced.
            await this.storage.putObject(storageKey, reflow.pdf, contentType || 'application/pdf');
            ocrBody = reflow.pdf;
            this.logger.log(
              `OCR job=${label} reflowed ${reflow.reflowedPages}/${reflow.pageCount} page(s); object rewritten`,
            );
          }
        } catch (err) {
          this.logger.warn(
            `OCR job=${label} layout reflow skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // Document Cleanup Engine (Python sidecar) — DECOUPLED from the OCR critical path AND DEFERRED
      // until AFTER extraction (see the call below, right after extract_complete). It used to fire HERE,
      // before the OCR loop, fire-and-forget — but the Python CV cleanup (CLEANUP_ENGINE=cv) then ran
      // CONCURRENTLY with the parallel Tesseract workers, starving them for CPU on this box (a page that
      // OCRs in ~7s measured 22s while cleanup churned). The cleanup only ever benefits SUBSEQUENT runs
      // (it overwrites the stored object; THIS run always OCRs the original bytes), so there is no reason
      // to start it before extraction — starting it AFTER frees every core for OCR and the cleanup then
      // runs on the idle box. OCR never waits for it; disabled/dead/slow/failed cleanup never affects OCR.
      const settings = readHandwritingSettings();
      // Phase 2 — initialize live progress: stage OCR_PROCESSING, processed=0.
      // Subsequent updates land via the onPageComplete callback below.
      await this.ocrJobs
        .updateProgress(ocrJobId, { stage: 'OCR_PROCESSING', processed: 0, total: 0 })
        .catch(() => undefined);
      // ASYNC CROP UPLOAD (segmentation throughput fix) — SEAM-LEVEL, not an engine change. The
      // segmenter `await opts.putObject(...)`s every question crop one at a time, so on slow/remote
      // storage the serial finalize tail is dominated by upload round-trips (measured: 19-page scan →
      // 151 crops → ~165s "Segment-only"). We inject a NON-BLOCKING putObject: it returns immediately
      // (the engine's loop never waits on a round-trip), runs the real upload on a bounded background
      // pool, and tracks the promise. We DRAIN all uploads right after extraction (below) — BEFORE
      // delivery, which reads crops back from storage — so correctness is identical; only upload TIMING
      // changes (the crop bytes + draft keys the engine computes are byte-identical). Opt out with
      // OCR_ASYNC_CROP_UPLOAD=0; tune fan-out with OCR_UPLOAD_CONCURRENCY (default 8).
      const asyncUpload = !/^(0|false|no|off)$/i.test(process.env.OCR_ASYNC_CROP_UPLOAD ?? '');
      const uploadCap = Math.max(1, Math.min(32, Number(process.env.OCR_UPLOAD_CONCURRENCY) || 8));
      const pendingUploads: Promise<void>[] = [];
      let activeUploads = 0;
      const uploadWaiters: Array<() => void> = [];
      const releaseUpload = (): void => {
        activeUploads -= 1;
        const next = uploadWaiters.shift();
        if (next) next();
      };
      const asyncPutObject = (key: string, payload: Buffer, ct: string): Promise<void> => {
        const job = (async () => {
          if (activeUploads >= uploadCap) await new Promise<void>((res) => uploadWaiters.push(res));
          activeUploads += 1;
          try {
            await this.storage.putObject(key, payload, ct);
          } catch (err) {
            this.logger.warn(`crop upload failed ${key} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            releaseUpload();
          }
        })();
        pendingUploads.push(job);
        return Promise.resolve(); // engine continues immediately; uploads are drained after extraction
      };
      const enginePutObject = asyncUpload
        ? asyncPutObject
        : (key: string, payload: Buffer, ct: string) => this.storage.putObject(key, payload, ct);

      // Slice 2.3 + Phase 2: hand the storage adapter to the engine so figure
      // crops detected during OCR can be uploaded directly (no client
      // round-trip), AND hand a progress callback so the UI can show per-page
      // completion while the OCR loop runs.
      const outcome = await resolveDrafts(ocrBody, contentType, storageKey, {
        settings,
        putObject: enginePutObject,
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
        // Resumable OCR (P0) — checkpoint each page's OCR artifact and skip pages
        // already done on a resumed run. Disabled (no-op) when OCR_RESUMABLE=0.
        loadPageOcr: resumable
          ? (page) => this.ocrJobs.loadPageCheckpoint(ocrJobId, page)
          : undefined,
        savePageOcr: resumable
          ? (page, total, data) =>
              this.ocrJobs.savePageCheckpoint(ocrJobId, page, total, data).catch(() => undefined)
          : undefined,
      });
      phase.extractDone = Date.now() - t0;
      this.logger.log(
        `[ocr-timing] extract_complete job=${label} +${phase.extractDone}ms outcome=${outcome.kind}`,
      );

      // DRAIN async crop uploads — delivery (next) reads crops back from storage (merged-crop stitch /
      // analysis / crop-clean), so every crop must be persisted first. Because the segmenter no longer
      // blocked on each upload, these overlapped with the (CPU-bound) segmentation work, so the drain is
      // typically short. This is the only place the uploads are awaited; nothing downstream sees a
      // difference vs the old serial-upload behaviour.
      if (asyncUpload && pendingUploads.length) {
        const drainT0 = Date.now();
        await Promise.all(pendingUploads);
        this.logger.log(
          `[ocr-timing] crop_uploads_drained job=${label} count=${pendingUploads.length} +${Date.now() - drainT0}ms`,
        );
      }
      phase.uploadDrainDone = Date.now() - t0;

      // DEFERRED background cleanup — fire it now that extraction is done, so it never competes with the
      // (CPU-bound) Tesseract OCR. Single-flight (cleanup-orchestrator.ts), 15s cap, fire-and-forget; a
      // success overwrites the stored object for SUBSEQUENT runs only. OCR/delivery never wait for it.
      // HYBRID ARCHITECTURE (2026-06-24): background removal is permanently OFF — the client pre-cleans
      // the PDF externally and the CV cleanup overwriting the SOURCE object caused content loss. Gate it
      // behind the SAME master switch as every other background pass so one flag governs the whole engine
      // (this is belt-and-suspenders over CLEANUP_ENGINE_ENABLED, which already defaults OFF).
      if (backgroundRemovalEnabled()) {
        startBackgroundCleanup(
          { uploadId, ocrJobId, storageKey, bytes: ocrBody, contentType },
          { putObject: (key, body, ct) => this.storage.putObject(key, body, ct), logger: this.logger },
        );
      } else {
        this.logger.log(`[cleanup] skipped upload=${uploadId} — background removal disabled (hybrid TS-crops architecture)`);
      }

      // PROGRESS: OCR pages are done. Flip the stage to EXTRACTING so the bar moves PAST the OCR ceiling
      // while the (multi-second) Python analysis + crop rendering + draft persistence run in persist()
      // below. Without this the stage stays OCR_PROCESSING at processed==total, so the UI would sit at
      // the OCR ceiling — looking almost done — for the entire post-OCR phase. Best-effort.
      await this.ocrJobs.updateProgress(ocrJobId, { stage: 'EXTRACTING' }).catch(() => undefined);

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
            await this.persist(ocrJobId, py, uploadId);
            if (resumable) await this.ocrJobs.markCompletedStatus(ocrJobId).catch(() => undefined);
            this.metrics.record('routed_http', outcome.decision.reason);
            this.logger.log(
              `OCR job=${label} handwriting via HTTP → ${py.drafts.length} draft(s) | total=${Date.now() - t0}ms`,
            );
            return;
          }
          await this.persist(ocrJobId, outcome.nodeResult, uploadId);
          if (resumable) await this.ocrJobs.markCompletedStatus(ocrJobId).catch(() => undefined);
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
      await this.persist(ocrJobId, outcome.result, uploadId);
      if (resumable) await this.ocrJobs.markCompletedStatus(ocrJobId).catch(() => undefined);
      this.logger.log(
        `[ocr-timing] persist_complete job=${label} +${Date.now() - t0}ms persist_dur=${Date.now() - persistT0}ms`,
      );
      this.metrics.record('kept_node');
      const total = Date.now() - t0;
      // ── PHASE SUMMARY ── one line so the SLOW phase is obvious. storage_read = PDF download (network;
      // remote R2 is slow → use local storage in dev). ocr+seg = engine work (see the `[OCR] …` line for
      // its render/OCR/segmentation split). upload_drain = crop uploads (async). deliver+persist = Python
      // analysis + crop render + DB write. Each is wall-clock seconds.
      const sec = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
      const storageRead = phase.storageReadDone;
      const ocrSeg = Math.max(0, phase.extractDone - phase.storageReadDone);
      const uploadDrain = Math.max(0, phase.uploadDrainDone - phase.extractDone);
      const deliverPersist = Math.max(0, total - phase.uploadDrainDone);
      this.logger.log(
        `[ocr-timing] PHASE SUMMARY job=${label} | storage_read=${sec(storageRead)} ocr+seg=${sec(ocrSeg)} ` +
          `crop_upload_drain=${sec(uploadDrain)} deliver+persist=${sec(deliverPersist)} | TOTAL=${sec(total)} ` +
          `(slowest=${[['storage_read', storageRead], ['ocr+seg', ocrSeg], ['deliver+persist', deliverPersist]].sort((a, b) => (b[1] as number) - (a[1] as number))[0][0]})`,
      );
      this.logger.log(
        `OCR job=${label} delivered ${outcome.result.drafts.length} draft(s) | total=${total}ms provider=${outcome.result.providerUsed}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A memory-guard abort is PERMANENT: the document is too big for this tier,
      // so resuming would just OOM again and burn every resume attempt. Skip the
      // resumable pause path and fail the upload cleanly with the guidance message.
      const permanent = err instanceof OcrMemoryLimitError;
      if (resumable && !permanent) {
        // Resumable OCR (P0): do NOT discard progress and do NOT fail the upload.
        // Pause the job (checkpoints stay intact, upload stays PROCESSING) so the
        // recovery service resumes it from the last completed page. attemptCount
        // (bumped on every markRunning) caps this loop — failExhausted FAILS the
        // job for good once the cap is hit, so a genuinely-poison job still settles.
        this.logger.error(`OCR job=${label} PAUSED (resumable): ${message}`);
        await this.ocrJobs.markPaused(ocrJobId, message.slice(0, 500)).catch(() => undefined);
        // A Tesseract worker-thread fault can poison the singleton — drop it so
        // the next (resumed) run re-initialises cleanly. Never crash the host.
        resetTesseract();
        if (opts.rethrow) throw err;
        return;
      }
      this.logger.error(`OCR job=${label} FAILED: ${message}`);
      // Legacy (OCR_RESUMABLE=0): flip the upload to FAILED via the same use-case,
      // then (BullMQ path only) rethrow so BullMQ applies its retry/backoff policy.
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
      // Permanent (memory-limit) failures must NOT be retried by BullMQ — the same
      // oversized document on the same tier would fail identically. Swallow the
      // rethrow so the job settles as failed-once; the upload is already FAILED.
      if (opts.rethrow && !permanent) throw err;
    }
  }
}
