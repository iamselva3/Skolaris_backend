import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import { detectLeadingMarker, stitchVertical, whitenRegion } from '../../shared/ocr-engine/visual-segment';
import { liftBackground, removeColumnDivider } from '../../shared/ocr-engine/crop-display-clean';
import { readStructureSettings, validateStructureHttp } from '../../shared/ocr-engine/structure-http';
import {
  analyzeDocumentHttp,
  buildDocumentHttp,
  processDocumentHttp,
  readStructureAnalyzeSettings,
  readStructureBuildSettings,
  type AnalyzePage,
  type DocumentAnalysisProposal,
  type ProposalQuestion,
} from '../../shared/ocr-engine/structure-analyze-http';
import { OcrShadowAnalyzer, PageInput } from './ocr-shadow-analyzer';
import { BBox, ShadowDraft, ShadowWord } from './contracts';

/**
 * OCR ANALYSIS DELIVERY — the production seam adapter that makes the client receive the SAME logical
 * question set `analyzePaper` produces (ONE source of truth), instead of the raw engine segmentation.
 *
 * It runs the EXISTING full stack (PageAnalyzer → 8 detectors → CorrectionApplier → QuestionLifecycle
 * → validation → delivery gate) over the engine's already-computed per-page words + page images (NO
 * re-OCR, no duplicated pipeline). Then it RECONCILES the live draft set to the emitted set:
 *   • drafts the framework removed/absorbed (duplicates, content-numerals, split orphans, cross-page
 *     continuations) are DROPPED — so 1 logical question = 1 crop;
 *   • a merged question's crop is rebuilt as the union of its constituent region crops, reusing the
 *     engine's own `stitchVertical` (no new image logic);
 *   • everything else is delivered byte-identical.
 * Detector/merge/threshold logic is untouched — this only DELIVERS the framework's existing decision.
 */
/**
 * HYBRID ARCHITECTURE GATE (2026-06-24). ON by default. When ON, the TS engine OWNS the physical
 * crops (segmentation, numbering, rendering, stitching, storage); Python is INTELLIGENCE-ONLY —
 * it validates ownership / cross-page / cross-column / neighbour-leak / diagram-table-equation-
 * chemical ownership and detects header/footer bands, but it NEVER renders, computes crop
 * boundaries, or replaces the crop set. TS applies Python's `chromeBands` (header/footer) to its own
 * crops at render time. Python disagreeing with TS's set ⇒ the document routes to REVIEW (never a
 * silent delivery). Set OCR_TS_OWNS_CROPS=0/false/off to restore the legacy Python-owns-crops path
 * (renderProposalCrops replaces `out` with crops cut at Python's cropRegions).
 */
export const tsOwnsCropsEnabled = (): boolean =>
  !/^(0|false|no|off)$/i.test(process.env.OCR_TS_OWNS_CROPS ?? '');

export interface DeliverableDraft {
  position: number;
  text?: string | null;
  questionNumber?: number | null;
  sourcePageNumber?: number | null;
  sourceCoordinates?: { x0: number; y0: number; x1: number; y1: number } | null;
  questionSnapshotKey?: string;
  [k: string]: unknown; // pass-through fields (options, optionCount, detectedType, figures, …)
}

export interface DeliveryArtifacts {
  wordsByPage: ShadowWord[][]; // index = pageNumber-1
  pageImages: Buffer[]; // index = pageNumber-1
}

export interface DeliveryIO {
  getObject: (key: string) => Promise<Buffer>;
  putObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
  figureKeyPrefix: string;
}

/** Authority proof object — served at GET /ocr/jobs/:id/authority (persisted in OcrJob.rawOutput). */
export interface AuthorityReport {
  pyLogical: number;
  pyOwnership: number;
  pyComplete: number;
  pyCrops: number;
  pyDelivered: number;
  tsStored: number;
  intercepted: boolean;
  stage1: boolean;
  stage2: string;
  deliver: boolean;
  recovered: number[];
  missing: number[];
  duplicates: number[];
  questionZero: boolean;
  impossible: number;
  rejected: Array<{
    questionNumber: number | null;
    ownershipStatus: string;
    visualStatus: string;
    cropStatus: string;
    completeness: number;
    deliverable: boolean;
    reason: string;
  }>;
}

export interface DeliveryResult {
  drafts: DeliverableDraft[];
  removed: number;
  splitMerged: number;
  crossPageMerged: number;
  trimmedCrops: number;
  deliverable: boolean;
  /** Python authority proof (build mode only); null in legacy/analyze mode. */
  authority?: AuthorityReport | null;
}

@Injectable()
export class OcrAnalysisDeliveryService {
  private readonly logger = new Logger('ocr-delivery');

  constructor(private readonly analyzer: OcrShadowAnalyzer) {}

  /**
   * P4 — MANDATORY PRE-PERSIST COMPLETENESS VALIDATION. A crop is COMPLETE only if it carries a valid
   * question number (a POSITIVE integer, in-sequence, not a duplicate) and, for an MCQ, its option
   * block. A crop that is an ORPHAN (no valid number — e.g. a second-column option block, the ex-
   * "Question 0"), an OUT-OF-SEQUENCE phantom (e.g. 234/235 on a 180-question paper, from broken
   * options), a DUPLICATE number, or an MCQ MISSING its options is INCOMPLETE → flagged
   * needsImageReview + invalidCrop so it is routed to REVIEW, never delivered as a clean question.
   * Mutates the drafts in place and returns how many were flagged. Generic, value-free — the range
   * cap is derived from THIS paper's own count, no literals.
   */
  static validateCompleteness(out: DeliverableDraft[]): number {
    // Range cap via a GAP-WALK over the dense number run, so a phantom outlier (234/235) can never
    // inflate the cap and whitelist itself. Start at the question count, extend through contiguous-ish
    // numbers, and STOP at the first big gap — everything above that gap is a broken-options phantom.
    const sorted = [...new Set(out.map((d) => d.questionNumber).filter((n): n is number => typeof n === 'number' && n > 0))].sort((a, b) => a - b);
    let rangeCap = Math.max(out.length, sorted[0] ?? 0);
    for (const n of sorted) {
      if (n <= rangeCap + Math.max(5, rangeCap * 0.5)) rangeCap = Math.max(rangeCap, n);
      else break; // a big jump ⇒ outlier region begins ⇒ stop extending the valid range
    }
    const seen = new Set<number>();
    let flagged = 0;
    for (const d of out) {
      const n = d.questionNumber;
      const opt = (d as { optionCount?: number }).optionCount ?? 0;
      const cls = (d as { questionClass?: string }).questionClass;
      const numbered = typeof n === 'number' && n > 0;
      const duplicate = numbered && seen.has(n);
      if (numbered) seen.add(n);
      const badNumber = !numbered || (n as number) > rangeCap || duplicate; // orphan / phantom / dup
      const missingOptions = cls === 'MCQ' && opt < 2; // MCQ with no option block ⇒ incomplete
      if (badNumber || missingOptions) {
        (d as { needsImageReview?: boolean }).needsImageReview = true;
        (d as { invalidCrop?: boolean }).invalidCrop = true;
        flagged += 1;
      }
    }
    return flagged;
  }

  /** Per-page divider-cleaned source for delivery re-crops. The delivery path re-cuts the DELIVERED
   *  crop from the RAW page (`artifacts.pageImages`), which never went through `cleanPageForDisplay`,
   *  so the column divider would survive ONLY in delivered crops. Apply the same Sharp utility here
   *  (memoised per page buffer) so delivered crops match the engine crops. Display-only, never OCR. */
  private readonly dividerCleaned = new WeakMap<Buffer, Promise<Buffer>>();
  private cleanedPageSource(page: Buffer): Promise<Buffer> {
    let p = this.dividerCleaned.get(page);
    if (!p) {
      p = removeColumnDivider(page);
      this.dividerCleaned.set(page, p);
    }
    return p;
  }

  async deliver(
    drafts0: ReadonlyArray<DeliverableDraft>,
    artifacts: DeliveryArtifacts,
    io: DeliveryIO,
  ): Promise<DeliveryResult> {
    // P7 — NEVER PERSIST INVALID CROPS. Drop drafts the engine flagged invalidCrop (a region with no
    // stem and no option block: an answer-grid / correction-list row, a footer fragment, a degenerate
    // sliver). On clean papers this is a no-op (none are flagged). The whole-PDF N=N gate below catches
    // any resulting count drift and routes the upload to review (never a silent bad delivery).
    const drafts = drafts0.filter((d) => !(d as { invalidCrop?: boolean }).invalidCrop);
    const invalidDropped = drafts0.length - drafts.length;
    // No artifacts (e.g. Paddle path / single image) → deliver the (invalid-filtered) set unchanged.
    if (!artifacts.pageImages?.length || !artifacts.wordsByPage?.length) {
      return { drafts: [...drafts], removed: invalidDropped, splitMerged: 0, crossPageMerged: 0, trimmedCrops: 0, deliverable: true };
    }

    // Build PageInput[] from the live drafts grouped by page + the engine's words/images.
    const byPage = new Map<number, Array<{ d: DeliverableDraft; index: number }>>();
    drafts.forEach((d, index) => {
      const page = d.sourcePageNumber ?? 1;
      const g = byPage.get(page);
      if (g) g.push({ d, index });
      else byPage.set(page, [{ d, index }]);
    });
    const pages: PageInput[] = [];
    for (let p = 1; p <= artifacts.pageImages.length; p += 1) {
      const entries = byPage.get(p) ?? [];
      const shadow: ShadowDraft[] = entries.map(({ d, index }) => ({
        index,
        page: p,
        questionNumber: d.questionNumber ?? null,
        text: d.text ?? '',
        coords: toBBox(d.sourceCoordinates),
      }));
      pages.push({ pageImage: artifacts.pageImages[p - 1], pageIndex: p, drafts: shadow, words: artifacts.wordsByPage[p - 1] ?? [] });
    }

    const report = await this.analyzer.analyzePaper(pages);
    const provByIdx = new Map(report.appliedProvenance.map((pr) => [pr.draftIndex, pr]));
    const emitted = report.lifecycle.filter((l) => l.emittedCrop);
    const keptIdx = new Set(emitted.map((l) => l.draftIndex));

    let splitMerged = 0;
    let crossPageMerged = 0;
    let trimmedCrops = 0;
    const out: DeliverableDraft[] = [];
    for (const l of emitted) {
      const src = drafts[l.draftIndex];
      if (!src) continue;
      const prov = provByIdx.get(l.draftIndex);
      const emittedBbox = l.emittedCrop as BBox;
      const merged = prov && prov.mergedRegions.length > 1;
      const trimY = prov?.trimmedToY ?? null; // EXPLANATION/SOLUTION/ANSWER/HINT trim boundary
      const next: DeliverableDraft = { ...src, position: out.length, sourceCoordinates: emittedBbox };

      if (merged) {
        const crossPage = (prov!.sourcePages?.length ?? 1) > 1;
        if (crossPage) crossPageMerged += 1;
        else splitMerged += 1;
        // Rebuild ONE crop = union of the constituent region crops, reusing the engine's stitcher.
        // Members = this survivor + the absorbed drafts whose region falls inside a merged bbox.
        const memberKeys = this.memberCropKeys(drafts, l.draftIndex, prov!.mergedRegions, keptIdx);
        const stitched = await this.stitchCrops(memberKeys, io);
        if (stitched) {
          const key = `${io.figureKeyPrefix}/merged-q${l.questionNumber ?? l.draftIndex}-p${l.page}.png`;
          await io.putObject(key, stitched, 'image/png');
          next.questionSnapshotKey = key;
        }
      } else if (typeof trimY === 'number' && (toBBox(src.sourceCoordinates)?.y1 ?? trimY) > trimY && l.page <= artifacts.pageImages.length) {
        // The trailing solution/answer/explanation/hint block is below the options. The framework
        // already trimmed the EMITTED bbox to the boundary; the engine's stored crop still spans the
        // ORIGINAL (untrimmed) draft, so re-crop the page image to the emitted bbox → the DELIVERED
        // crop carries Question+Options ONLY. Structural boundary, keyword-free, any trailing block.
        const cropped = await this.cropToY(artifacts.pageImages[l.page - 1], emittedBbox, emittedBbox.y1, artifacts.wordsByPage[l.page - 1] ?? []);
        if (cropped) {
          const key = `${io.figureKeyPrefix}/trimmed-q${l.questionNumber ?? l.draftIndex}-p${l.page}.png`;
          await io.putObject(key, cropped, 'image/png');
          next.questionSnapshotKey = key;
          next.sourceCoordinates = { ...emittedBbox, y1: trimY };
          trimmedCrops += 1;
        }
      }
      out.push(next);
    }

    let reviewFlagged = OcrAnalysisDeliveryService.validateCompleteness(out);

    // PYTHON STRUCTURAL VALIDATOR (Flow: …8 detectors → HERE → persist). Reuses the EXISTING localhost
    // sidecar (cleanup engine on :8002) via its new /validate-structure route — no new service/port.
    // For each crop not already flagged, Python (CV only, NO OCR) confirms it is a COMPLETE question:
    // content not cut at the edge, options present (Node count) or a diagram, not split across a
    // column. complete===false ⇒ route to REVIEW. Opt-in (STRUCTURE_VALIDATOR_ENABLED); any failure /
    // disabled / `complete:null` ⇒ DEGRADE to the Node P4 verdict above. Python never decides number/
    // text/options. (Crops live in storage via questionSnapshotKey; the sidecar fetches them read-only.)
    const sset = readStructureSettings();
    if (sset.enabled && sset.serviceUrl) {
      for (const d of out) {
        if ((d as { needsImageReview?: boolean }).needsImageReview) continue; // already routed to review
        const key = d.questionSnapshotKey;
        if (!key) continue;
        const rep = await validateStructureHttp(
          { cropStorageKey: key, isMcq: (d as { questionClass?: string }).questionClass === 'MCQ', optionCount: (d as { optionCount?: number }).optionCount ?? 0 },
          { serviceUrl: sset.serviceUrl, timeoutMs: sset.timeoutMs },
        );
        if (rep && rep.complete === false) {
          (d as { needsImageReview?: boolean }).needsImageReview = true;
          (d as { invalidCrop?: boolean }).invalidCrop = true;
          reviewFlagged += 1;
        }
      }
    }

    // PYTHON DOCUMENT-INTELLIGENCE ENGINE — the SINGLE source of truth for document structure.
    // Flow: TS extracts → Python intelligence → ownership graph → N=N=C → TS persists. Reuses the SAME
    // localhost sidecar (:8002) via /analyze-document — no new service/port. Python owns ownership /
    // merge / continuation / cross-column / cross-page / orphan / broken-option / incomplete-crop
    // detection; TS no longer competes on those. Python's ownership graph is AUTHORITATIVE: the emitted
    // question set must CONFORM to it (N=N=C) or the whole document routes to review. TS keeps OCR
    // extraction, business rules, answer-key / MCQ / numbering validation, persistence, review routing.
    // Opt-in (STRUCTURE_ANALYZE_ENABLED, default OFF until the engine is complete + validated); any
    // failure / disabled / null proposal ⇒ keep the TS-only path. Golden rule: uncertain → review →
    // do NOT persist / deliver. Python never persists (TS persists); Python never touches the DB.
    // Capture the real TS-OCR token payload for offline regression validation (gated; no-op in prod).
    // Validation must run the SAME TS OCR → Python path for ALL docs — never a PyMuPDF/offline shortcut.
    await this.captureTokens(artifacts, io.figureKeyPrefix);

    // END-TO-END BUILD (Python is the single engine; gated STRUCTURE_BUILD_ENABLED, default OFF until
    // live-validated). When ON, Python builds + repairs + validates crops and returns them; TS only
    // STORES them when every gate passes (Stage 1 + cropGate + Stage 2). Any failure ⇒ review, never a
    // silent delivery. When OFF, the analyze-only advisory path runs (TS crops kept).
    // SINGLE STRUCTURAL PATH — Python is the only authority. `applyStructuralProposal` renders Python's
    // question set (TS executes Python's crop boundaries), replaces `out` with it, and enforces the
    // Expected==Logical==Ownership==Crop==Delivered gate. The TS analyzer/completeness pre-pass above is
    // INFORMATIONAL ONLY: its flags sit on drafts that Python's set replaces, and it no longer decides
    // delivery. TS never keeps its own count.
    const structural = await this.applyStructuralProposal(out, artifacts, io);
    reviewFlagged += structural.added;
    const structuralStop = structural.stop;
    // PROVE the Python analyze single-flow ran (the ts-only/build banner does NOT reflect it). A stale
    // sidecar / no-OCR-words / error is named here so "did Python run?" is answerable from one line.
    this.logger.log(
      `[python-analyze] ran=${structural.ran} logical=${structural.logical ?? '-'} ` +
        `crop=${structural.crop ?? '-'} verdict=${structural.verdict ?? '-'} delivered=${out.length}`,
    );

    this.logger.log(
      `delivery: engine=${drafts0.length} → valid=${drafts.length} → emitted=${out.length} (invalidDropped=${invalidDropped} removed=${drafts.length - keptIdx.size} splitMerged=${splitMerged} xpageMerged=${crossPageMerged} reviewFlagged=${reviewFlagged})`,
    );
    return {
      drafts: out,
      removed: invalidDropped + (drafts.length - keptIdx.size),
      splitMerged,
      crossPageMerged,
      trimmedCrops,
      // Python is the SINGLE authority: `out` is Python's rendered set and the structural gate already
      // enforced the full N=N=C chain. Deliverable iff that gate did not stop. The TS reconciliation
      // count (`report.reconciliation.finalLogicalCount`) is informational only and never consulted.
      deliverable: !structuralStop,
      authority: null,
    };
  }

  /**
   * END-TO-END BUILD seam — Python builds the crops; TS only stores them. Gated by
   * STRUCTURE_BUILD_ENABLED (default OFF). Sends words + page renders to /build-document; when Python
   * returns `deliver:true` (all gates passed), stores each valid crop and swaps it into the matching
   * draft (Python owns the crop image; TS keeps the record + persists). When `deliver:false` (any gate
   * failed) routes the whole document to review. Returns `handled:false` when build mode is off / the
   * call failed (caller falls back to the advisory analyze path). Never throws.
   */
  /**
   * SINGLE PYTHON DOCUMENT ENGINE delivery. TS hands Python the uploaded document's storage key; Python
   * runs the COMPLETE lifecycle (OCR router → ownership → crops → N=N=C → deliver) and returns the final
   * result. TS only MAPS it to drafts + STORES the crop PNGs — it performs no OCR, counting, cropping,
   * validation, merging, dedup, or modification. One Python question = one draft = one crop (Python is
   * authoritative; `intercepted` is always false on this path). `deliver` is true ONLY when Python says
   * so AND no page degraded; otherwise the WHOLE upload routes to review (every draft flagged) — never a
   * partial/silent delivery, never a fall back to TS. Returns null if the engine is unavailable (caller
   * routes to review; it must NOT run TS OCR).
   */
  async deliverPythonDocument(
    storageKey: string,
    documentId: string,
    io: DeliveryIO,
  ): Promise<{ drafts: DeliverableDraft[]; deliver: boolean; authority: AuthorityReport; degradedPages: number } | null> {
    const bset = readStructureBuildSettings();
    if (!bset.enabled || !bset.serviceUrl) return null;
    const result = await processDocumentHttp(
      { storageKey, documentId },
      { serviceUrl: bset.serviceUrl, timeoutMs: bset.timeoutMs },
    );
    if (!result) return null;

    const cropByQ = new Map<string, (typeof result.crops)[number]>();
    for (const c of result.crops ?? []) cropByQ.set(c.questionId, c);

    // Trust Python's own delivery decision verbatim — it already isolates degraded-page impact (a
    // raster-only degraded page whose text + crops are intact does NOT block; only a page that lost
    // ALL its tokens does). TS never re-derives or second-guesses the gate.
    const deliver = result.deliver === true;
    const drafts: DeliverableDraft[] = [];
    let position = 0;
    for (const q of result.questions ?? []) {
      const crop = cropByQ.get(q.id);
      let snapshotKey: string | undefined;
      if (crop?.pngBase64 && crop.number != null) {
        snapshotKey = `${io.figureKeyPrefix}/py-q${crop.number}.png`;
        await io.putObject(snapshotKey, Buffer.from(crop.pngBase64, 'base64'), 'image/png');
      }
      const text = (q.boxes ?? [])
        .map((b) => (b.text ?? '').trim())
        .filter(Boolean)
        .join(' ')
        .trim();
      const valid = crop?.valid === true;
      // SCREENSHOT-FIRST PARITY (the existing TS Visual-Question behaviour): EVERY Python-built question
      // is a VISUAL question whose CROP IMAGE is the source of truth (it already contains the question
      // text, options, diagrams, equations, tables, chemical structures). It is NEVER a text type and
      // NEVER carries an extracted a/b/c/d `options` array — either of those makes the UI render a
      // textarea + empty option fields (the regression). `text` is metadata only (not rendered for
      // VISUAL, like the engine's screenshot-first draft); `optionCount` drives the positional
      // correct-option selector (1..N), exactly as in the required UI.
      // MANDATORY CROP RULE: a VISUAL question's IMAGE is the whole question. No crop ⇒ there is no
      // question to deliver ⇒ it can NEVER be a clean draft; it routes to review. We never fabricate a
      // text/option placeholder to stand in for a missing image. (Crop present + Python deliver ⇒ clean.)
      const hasCrop = !!snapshotKey;
      drafts.push({
        position: position++,
        // questionNumber must be a positive int or omitted (DTO @Min(1)); a recovered visual may have none.
        questionNumber: typeof q.number === 'number' && q.number >= 1 ? q.number : null,
        // VISUAL: text is REAL OCR metadata or EMPTY — NEVER a fabricated "Question N" placeholder. The
        // crop image carries the number/text/options/diagrams; the UI renders the image, not this text.
        text,
        detectedType: 'VISUAL',
        optionCount: q.optionCount ?? 0,
        questionSnapshotKey: snapshotKey,
        sourcePageNumber: (q.startPage ?? 0) + 1,
        spanPageStart: (q.startPage ?? 0) + 1,
        spanPageEnd: (q.endPage ?? q.startPage ?? 0) + 1,
        // Only two states: (a) crop valid + Python delivers ⇒ clean VISUAL draft; (b) otherwise ⇒ review.
        // No crop ⇒ ALWAYS review (never a placeholder). deliver=false ⇒ whole upload to review.
        invalidCrop: deliver && valid && hasCrop ? false : true,
      } as DeliverableDraft);
    }

    // PLACEHOLDER GUARD — the forbidden state ("Question N" + empty textarea + a/b/c/d) must never ship.
    // A placeholder = a CLEAN draft (invalidCrop=false) that lacks a crop image or carries a synthesized
    // "Question N" text. There must be ZERO; if any slip through, FAIL the whole upload to review.
    const placeholderRe = /^Question\s+\d+$/i;
    let placeholderDrafts = drafts.filter(
      (d) =>
        !(d as { invalidCrop?: boolean }).invalidCrop &&
        (!d.questionSnapshotKey || placeholderRe.test(String(d.text ?? ''))),
    ).length;
    if (placeholderDrafts > 0) {
      for (const d of drafts) (d as { invalidCrop?: boolean }).invalidCrop = true;
      this.logger.error(`[python-engine] placeholderDrafts=${placeholderDrafts} — FAIL: routing entire upload to review`);
    }
    const deliverable = deliver && placeholderDrafts === 0;
    const validCrops = drafts.filter((d) => !(d as { invalidCrop?: boolean }).invalidCrop).length;
    const authority = this.buildAuthorityReport(result, false, drafts.length);
    this.logger.log(
      `[trace] doc=${documentId} questionCount=${result.questions?.length ?? 0} cropCount=${result.build?.cropCount ?? 0} ` +
        `validCropCount=${validCrops} deliver=${deliverable} review=${!deliverable} placeholderDrafts=${placeholderDrafts}`,
    );
    return { drafts, deliver: deliverable, authority, degradedPages: result.ocrDegradedPages ?? 0 };
  }

  /**
   * Build the AUTHORITY report — the proof object served at GET /ocr/jobs/:id/authority (persisted in
   * OcrJob.rawOutput.authority via the callback). NO files, NO env. Contains the count chain
   * (pyLogical=ownership=complete=crop=delivered=tsStored), `intercepted`, Stage 1/2 N=N=C,
   * recovered/missing, and `rejected[]` with a REASON per rejected question (never silently rejected).
   */
  private buildAuthorityReport(
    result: import('../../shared/ocr-engine/structure-analyze-http').BuildResult,
    intercepted: boolean,
    tsStored: number,
  ): AuthorityReport {
    const s1 = result.integrity?.nnc?.stage1;
    const cropByNum = new Map<number, (typeof result.crops)[number]>();
    for (const c of result.crops ?? []) if (c.number != null) cropByNum.set(c.number, c);
    const visualKeys = ['diagram', 'graph', 'table', 'equation', 'chemical_structure'];
    const rejected = (result.ownershipHeatmap ?? [])
      .filter((h) => !h.cropAllowed)
      .map((h) => {
        const crop = h.number != null ? cropByNum.get(h.number) : undefined;
        const e = crop?.edges;
        const edgeCut = !!e && (e.top || e.bottom || e.left || e.right);
        return {
          questionNumber: h.number,
          ownershipStatus: h.checks?.question_number === 'PASS' && h.checks?.question_text === 'PASS' ? 'PASS' : 'FAIL',
          visualStatus: visualKeys.some((k) => h.checks?.[k] === 'FAIL') ? 'FAIL' : 'PASS',
          cropStatus: crop ? (crop.valid && !edgeCut ? 'PASS' : 'FAIL') : 'MISSING',
          completeness: h.completeness,
          deliverable: h.cropAllowed,
          reason: h.missing?.[0] ?? h.detached?.[0] ?? h.ownershipConflicts?.[0] ?? 'incomplete',
        };
      });
    return {
      pyLogical: result.questions?.length ?? 0,
      pyOwnership: s1?.ownershipCount ?? 0,
      pyComplete: s1?.completeQuestionCount ?? 0,
      pyCrops: result.build?.cropCount ?? 0,
      pyDelivered: tsStored,
      tsStored,
      intercepted,
      stage1: s1?.pass ?? false,
      stage2: result.build?.stage2?.status ?? 'n/a',
      deliver: result.deliver,
      recovered: result.questionCount?.recoveredQuestions ?? [],
      missing: result.questionCount?.missingQuestions ?? [],
      duplicates: result.sequence?.duplicates ?? [],
      questionZero: result.sequence?.questionZero ?? false,
      impossible: result.sequence?.impossible?.length ?? 0,
      rejected,
    };
  }

  private async buildPythonCrops(
    out: DeliverableDraft[],
    artifacts: DeliveryArtifacts,
    io: DeliveryIO,
  ): Promise<{ handled: boolean; added: number; stop: boolean; delivered: number | null; authority: AuthorityReport | null }> {
    const bset = readStructureBuildSettings();
    if (!bset.enabled || !bset.serviceUrl) return { handled: false, added: 0, stop: false, delivered: null, authority: null };
    try {
      const pages = await this.buildAnalyzePages(artifacts);
      if (pages.length === 0) return { handled: false, added: 0, stop: false, delivered: null, authority: null };
      // attach the page renders (same coord space as the words) as base64
      for (const p of pages) {
        const buf = artifacts.pageImages[p.index - 1];
        if (buf) (p as { imageBase64?: string }).imageBase64 = buf.toString('base64');
      }
      const result = await buildDocumentHttp(
        { documentId: io.figureKeyPrefix, pages },
        { serviceUrl: bset.serviceUrl, timeoutMs: bset.timeoutMs },
      );
      if (!result) return { handled: false, added: 0, stop: false, delivered: null, authority: null }; // fall back to advisory path

      if (!result.deliver) {
        // a gate failed (completeness / Stage 1 / Stage 2) — route the whole document to review.
        let added = 0;
        for (const d of out) {
          if ((d as { needsImageReview?: boolean }).needsImageReview) continue;
          (d as { needsImageReview?: boolean }).needsImageReview = true;
          (d as { invalidCrop?: boolean }).invalidCrop = true;
          (d as { structuralReview?: string[] }).structuralReview = ['build_gate_failed'];
          added += 1;
        }
        this.logger.log(
          `python-build: deliver=false cropGate=${result.cropGate} stage1=${result.integrity?.nnc?.stage1?.pass} ` +
            `stage2=${result.build?.stage2?.status} crops=${result.build?.cropCount}/${result.questions?.length} → REVIEW`,
        );
        // deliver=false: rejected reasons recorded; not intercepted (TS set untouched, just review-flagged)
        return { handled: true, added, stop: true, delivered: out.length, authority: this.buildAuthorityReport(result, false, out.length) };
      }

      // DELIVER: Python's question SET is AUTHORITATIVE (count + ownership). The delivered drafts
      // are rebuilt as ONE draft per Python question — NO TS recount, NO TS re-merge. TS remains the
      // TEXT/DATA provider only: for a question both engines found we reuse the matched TS draft's
      // text/options/type; a Python-only question (one TS MISSED — the recovered "28/29") becomes a
      // VISUAL draft from Python's crop. TS phantoms (drafts with no Python owner) are dropped. This
      // removes the TS count/ownership interception: Python's 50 wins, not TS's 48.
      const cropByNumber = new Map<number, { key: string }>();
      for (const c of result.crops) {
        if (!c.valid || !c.pngBase64 || c.number == null) continue;
        const key = `${io.figureKeyPrefix}/py-q${c.number}.png`;
        await io.putObject(key, Buffer.from(c.pngBase64, 'base64'), 'image/png');
        cropByNumber.set(c.number, { key });
      }
      const tsByNumber = new Map<number, DeliverableDraft>();
      for (const d of out) if (typeof d.questionNumber === 'number') tsByNumber.set(d.questionNumber, d);

      const pyDrafts: DeliverableDraft[] = [];
      let pos = 0;
      let recovered = 0;
      for (const q of result.questions) {
        const ts = q.number != null ? tsByNumber.get(q.number) : undefined;
        const crop = q.number != null ? cropByNumber.get(q.number) : undefined;
        if (!ts) recovered += 1; // a question TS missed — recovered from Python's ownership graph
        pyDrafts.push({
          ...(ts ?? {}), // metadata pass-through (coords/page); content fields overridden below
          position: pos++,
          questionNumber: q.number ?? ts?.questionNumber ?? null,
          questionSnapshotKey: crop?.key ?? ts?.questionSnapshotKey, // crop image = source of truth
          sourcePageNumber: ts?.sourcePageNumber ?? q.startPage,
          optionCount: (ts as { optionCount?: number })?.optionCount ?? q.optionCount,
          // SCREENSHOT-FIRST PARITY: a Python-built question is ALWAYS a VISUAL question (the crop image
          // is the source of truth). NEVER inherit TS's text `detectedType` and NEVER carry an extracted
          // a/b/c/d `options` array — either makes the UI render a textarea + empty option fields (the
          // regression). `options` is explicitly cleared (it was spread in from the TS draft above);
          // `text` is metadata only (not rendered for VISUAL).
          detectedType: 'VISUAL',
          options: undefined,
          // Real OCR text or EMPTY — NEVER a fabricated "Question N" placeholder (the crop image is the
          // question). The DTO allows empty text for image-first VISUAL drafts.
          text: ts?.text || '',
          needsImageReview: false,
          invalidCrop: false,
          pythonBuilt: true,
        } as DeliverableDraft);
      }
      // replace the delivered set with Python's authoritative set (TS stores it verbatim)
      out.length = 0;
      out.push(...pyDrafts);

      // INTERCEPTION DETECTOR — prove TS did not modify Python's set. Python delivered count MUST
      // equal the persisted (out) count; the persist path writes `out` verbatim, so out.length IS
      // the TS Stored Count. intercepted=true ⇒ a bug re-touched the set ⇒ STOP → review.
      const pyLogical = result.questions.length;
      const pyOwnership = result.integrity?.nnc?.stage1?.ownershipCount ?? pyLogical;
      const pyComplete = result.integrity?.nnc?.stage1?.completeQuestionCount ?? pyLogical;
      const pyCrops = result.build?.cropCount ?? 0;
      const tsStored = out.length;
      const intercepted = tsStored !== pyLogical;
      this.logger.log(
        `[authority] buildPythonCrops entered | pyLogical=${pyLogical} pyOwnership=${pyOwnership} ` +
          `pyComplete=${pyComplete} pyCrops=${pyCrops} pyDelivered=${tsStored} tsStored=${tsStored} ` +
          `recovered(TS-missed)=${recovered} stage1=${result.integrity?.nnc?.stage1?.pass} ` +
          `stage2=${result.build?.stage2?.status} intercepted=${intercepted}`,
      );
      if (intercepted) {
        // PERSISTENCE GUARD — never silently persist a count TS reshaped. Route the whole doc to review.
        for (const d of out) {
          (d as { needsImageReview?: boolean }).needsImageReview = true;
          (d as { invalidCrop?: boolean }).invalidCrop = true;
          (d as { structuralReview?: string[] }).structuralReview = ['authority_interception'];
        }
        this.logger.error(
          `[authority] FAIL intercepted=true — Python delivered ${pyLogical} but stored ${tsStored}; routed to review`,
        );
        return { handled: true, added: out.length, stop: true, delivered: tsStored, authority: this.buildAuthorityReport(result, true, tsStored) };
      }
      return { handled: true, added: 0, stop: false, delivered: tsStored, authority: this.buildAuthorityReport(result, false, tsStored) };
    } catch (err) {
      this.logger.warn(`python build skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      return { handled: false, added: 0, stop: false, delivered: null, authority: null };
    }
  }


  /**
   * Build the per-page token payload Python reasons over — the ONE input contract for ALL PDFs
   * (scanned / digital / mixed). `words` are the TS OCR tokens (NO re-OCR); page dims come from the
   * render. Identical regardless of source type — there is no alternate/offline path.
   */
  /**
   * Classify a document as SCANNED from the PLATFORM-OCR analysis result — pure document evidence, no file
   * names, no flags. A digital PDF (clean text layer) comes back fully numbered (no sequence gaps); a
   * scanned PDF comes back severely UNDER-DETECTED because the platform OCR dropped question numbers and
   * option labels. Signal: a material fraction of the expected numbering is missing. Universal threshold
   * (relative to the document's own detected range), so it generalises to unseen documents.
   */
  private looksScanned(proposal: { questionCount?: { logicalQuestionCount?: number; expectedCount?: number; missingQuestions?: number[] } } | null): boolean {
    const qc = proposal?.questionCount;
    if (!qc) return false;
    const logical = qc.logicalQuestionCount ?? 0;
    const expected = qc.expectedCount ?? logical;
    const missing = qc.missingQuestions?.length ?? Math.max(0, expected - logical);
    if (expected < 4) return false; // too few to judge; never re-OCR a tiny/clean doc
    return missing >= Math.max(3, Math.ceil(0.15 * expected));
  }

  private async buildAnalyzePages(artifacts: DeliveryArtifacts): Promise<AnalyzePage[]> {
    const pages: AnalyzePage[] = [];
    for (let i = 0; i < artifacts.wordsByPage.length; i += 1) {
      const words = artifacts.wordsByPage[i] ?? [];
      if (words.length === 0) continue;
      let width = 0;
      let height = 0;
      const buf = artifacts.pageImages[i];
      if (buf) {
        try {
          const meta = await sharp(buf).metadata();
          width = meta.width ?? 0;
          height = meta.height ?? 0;
        } catch {
          /* dims are optional — Python falls back to the token content bounds */
        }
      }
      pages.push({
        index: i + 1,
        width,
        height,
        words: words.map((w) => ({ text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 })),
      });
    }
    return pages;
  }

  /**
   * Capture the EXACT TS-OCR token payload (the real production path's input) to disk for offline
   * validation — so the regression suite runs the SAME `TS OCR → Python` path, never a PyMuPDF/offline
   * shortcut. Gated by `STRUCTURE_CAPTURE_DIR` (unset in production ⇒ no-op). Best-effort; never throws.
   */
  private async captureTokens(artifacts: DeliveryArtifacts, documentId: string): Promise<void> {
    const dir = process.env.STRUCTURE_CAPTURE_DIR;
    if (!dir) return;
    try {
      const pages = await this.buildAnalyzePages(artifacts);
      if (pages.length === 0) return;
      // include the page renders so captures can drive the SAME /build-document path (not just analyze)
      for (const p of pages) {
        const buf = artifacts.pageImages[p.index - 1];
        if (buf) (p as { imageBase64?: string }).imageBase64 = buf.toString('base64');
      }
      await fs.mkdir(dir, { recursive: true });
      const safe = documentId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'doc';
      await fs.writeFile(join(dir, `${safe}.tokens.json`), JSON.stringify({ documentId, pages }), 'utf8');
      this.logger.log(`captured TS-OCR tokens for validation: ${safe}.tokens.json (${pages.length} pages)`);
    } catch (err) {
      this.logger.warn(`token capture skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Apply the Python document-intelligence engine — the SINGLE source of truth for document structure.
   * Builds the per-page token payload from the OCR words (NO re-OCR), asks Python for the ownership
   * graph, then ENFORCES it: the emitted question set must CONFORM to Python (N=N=C) or the whole
   * document routes to review. Python never re-crops, relabels or persists; on uncertainty it routes to
   * review (golden rule). Disabled / failure / null proposal ⇒ keep the TS-only path (returns 0/false).
   * Never throws into the delivery path.
   */
  /**
   * PYTHON INTELLIGENCE → TS CROPS. Python's proposal is the COUNT + OWNERSHIP authority; TS RENDERS one
   * crop per Python question at Python's OWN region (the union of its owned boxes — number + text + all
   * options), using the SAME TS image pipeline as every other delivered crop (`cropToY`: column-divider
   * clean + background lift + question-number strip). Python's boxes are already in the TS page-image
   * PIXEL space (TS OCR produced them on these renders, and `buildAnalyzePages` sends those pixel dims),
   * so TS crops them with NO scale mismatch — Python never re-renders. A multi-page question stitches its
   * per-page crops. Returns one VISUAL draft per Python question, or null if nothing could be rendered.
   */
  private async renderProposalCrops(
    proposal: DocumentAnalysisProposal,
    artifacts: DeliveryArtifacts,
    io: DeliveryIO,
  ): Promise<DeliverableDraft[] | null> {
    // PARALLEL crop render + upload (bounded). This is the EXTRACTING-phase fix: each Python question's
    // crop was rendered (sharp) and uploaded to (slow, remote) storage ONE AT A TIME, so for a paper with
    // 150+ questions this phase took many minutes (the UI sat at "Extracting questions"). Every question's
    // crop is INDEPENDENT — the page images are read-only, the page-clean source is memoised, and each
    // upload has a unique key — so rendering them concurrently is output-identical (only the order of work
    // changes). Final draft `position` is reassigned in question order after the fan-out, so the delivered
    // set is byte-identical to the serial version. Tune with OCR_CROP_RENDER_CONCURRENCY (default 6).
    const questions = proposal.questions;
    const concurrency = Math.max(1, Math.min(16, Number(process.env.OCR_CROP_RENDER_CONCURRENCY) || 6));
    const slots: Array<DeliverableDraft | null> = new Array(questions.length).fill(null);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let i = next++; i < questions.length; i = next++) {
        try {
          slots[i] = await this.renderOneProposalCrop(questions[i], i, proposal, artifacts, io);
        } catch (err) {
          this.logger.warn(
            `crop render failed for q${questions[i]?.number ?? i} (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, questions.length) }, () => worker()));
    const drafts: DeliverableDraft[] = [];
    let position = 0;
    for (const d of slots) {
      if (!d) continue;
      d.position = position++; // reassign in question order so the set matches the serial output
      drafts.push(d);
    }
    return drafts.length ? drafts : null;
  }

  /** Render + upload ONE Python question's crop. Independent of every other question (shared page images
   *  are read-only; the page-clean source is memoised; the key is unique per question), so it is safe to
   *  run many of these concurrently. Returns the draft (position assigned by the caller) or null. */
  private async renderOneProposalCrop(
    q: DocumentAnalysisProposal['questions'][number],
    index: number,
    proposal: DocumentAnalysisProposal,
    artifacts: DeliveryArtifacts,
    io: DeliveryIO,
  ): Promise<DeliverableDraft | null> {
    // Python OWNS the crop boundary. Execute `q.cropRegions` VERBATIM (already chrome-clipped + padded
    // engine-side, in this page's pixel space) — TS performs NO boundary math. Fall back to the box-union
    // + chrome-clip only for an older proposal that predates cropRegions.
    const regions =
      q.cropRegions && q.cropRegions.length
        ? q.cropRegions.map((r) => ({ page: r.page, x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 }))
        : this.boxUnionRegions(q, proposal);
    if (!regions.length) return null;
    const pages = [...new Set(regions.map((r) => r.page))].sort((a, b) => a - b);
    // Crop EACH region SEPARATELY and stitch in reading order. A cross-COLUMN question has TWO regions
    // on the SAME page — stem at the bottom of the LEFT column + continuation/options at the top of the
    // RIGHT column. The old code took the per-page BOUNDING BOX of both, which spans the WHOLE page
    // (x = left.x0…right.x1, y = right.y0…left.y1) → the full-page crop the reviewer sees. Sorting by
    // (page, x0≈column, y0) puts left-column parts before right-column parts, so the stitched crop reads
    // stem → continuation. A single-column question still has exactly one region per page (no change).
    const ordered = [...regions].sort((a, b) => a.page - b.page || a.x0 - b.x0 || a.y0 - b.y0);
    const parts: Buffer[] = [];
    for (const r of ordered) {
      const pageImage = artifacts.pageImages[r.page - 1]; // Python page is 1-based (buildAnalyzePages)
      if (!pageImage) continue;
      if (r.y1 - r.y0 < 4 || r.x1 - r.x0 < 4) continue; // degenerate region → skip
      const words = (artifacts.wordsByPage[r.page - 1] ?? []).map((w) => ({ text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }));
      const crop = await this.cropToY(pageImage, { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 } as BBox, r.y1, words);
      if (crop) parts.push(crop);
    }
    if (!parts.length) return null;
    let merged = parts[0]; // stitch the region crops (cross-column AND cross-page) top-to-bottom
    for (let i = 1; i < parts.length; i += 1) merged = await stitchVertical(merged, parts[i]);
    // Unique, deterministic key per question (index makes it collision-free even for numberless ones).
    const key = `${io.figureKeyPrefix}/q${q.number ?? `x${index}`}.png`;
    await io.putObject(key, merged, 'image/png');
    return {
      position: 0, // reassigned by renderProposalCrops in question order
      questionNumber: typeof q.number === 'number' && q.number >= 1 ? q.number : null,
      text: '', // VISUAL — the crop IS the question (no placeholder, no extracted textarea)
      detectedType: 'VISUAL',
      optionCount: q.optionCount ?? 0,
      questionSnapshotKey: key,
      sourcePageNumber: pages[0],
      spanPageStart: pages[0],
      spanPageEnd: pages[pages.length - 1],
      // A crop is clean unless Python flagged this question for review or its boundary was invalid.
      invalidCrop: q.needsReview === true || q.cropValid === false,
    } as DeliverableDraft;
  }

  /**
   * FALLBACK ONLY — derive per-page crop regions from a question's owned boxes (union, chrome-clipped,
   * padded) for a proposal that predates Python's explicit `cropRegions`. The single live flow uses
   * Python's cropRegions; this exists so a stale proposal shape still renders rather than dropping the
   * question. TS does no geometry on the live path.
   */
  private boxUnionRegions(
    q: DocumentAnalysisProposal['questions'][number],
    proposal: DocumentAnalysisProposal,
  ): Array<{ page: number; x0: number; y0: number; x1: number; y1: number }> {
    const boxes = q.boxes ?? [];
    if (!boxes.length) return [];
    const out: Array<{ page: number; x0: number; y0: number; x1: number; y1: number }> = [];
    for (const page of [...new Set(boxes.map((b) => b.page))].sort((a, b) => a - b)) {
      const onPage = boxes.filter((b) => b.page === page);
      if (!onPage.length) continue;
      let x0 = Math.min(...onPage.map((b) => b.x0));
      let y0 = Math.min(...onPage.map((b) => b.y0));
      let x1 = Math.max(...onPage.map((b) => b.x1));
      let y1 = Math.max(...onPage.map((b) => b.y1));
      const band = proposal.chromeBands?.[String(page)];
      if (band) {
        const [headerBottom, footerTop] = band;
        if (headerBottom > 0 && y0 < headerBottom) y0 = headerBottom;
        if (footerTop > 0 && y1 > footerTop) y1 = footerTop;
      }
      if (y1 - y0 < 4) continue;
      const padX = Math.max(6, (x1 - x0) * 0.04);
      const padY = Math.max(6, (y1 - y0) * 0.04);
      x0 -= padX; y0 -= padY; x1 += padX; y1 += padY;
      out.push({ page, x0, y0, x1, y1 });
    }
    return out;
  }

  /**
   * HYBRID: apply Python's header/footer `chromeBands` to the TS-OWNED crops. Python DETECTS the
   * repeated header/footer band per page; TS APPLIES it by re-cropping (from the RAW page) ONLY the
   * crops whose region crosses into a band, and ONLY single-page crops (a stitched cross-page crop is
   * left exactly as the engine produced it). Background removal is OFF, so `cropToY` performs a pure
   * vertical CLIP of raw pixels here — never a content modification. Returns how many crops were
   * clipped. Best-effort: a failed re-crop keeps the original engine crop. TS never reads Python's
   * crop boundaries — only the band Y-coordinates.
   */
  private async applyChromeBandsToTsCrops(
    out: DeliverableDraft[],
    proposal: DocumentAnalysisProposal,
    artifacts: DeliveryArtifacts,
    io: DeliveryIO,
  ): Promise<number> {
    const bands = proposal.chromeBands;
    if (!bands || Object.keys(bands).length === 0) return 0;
    let clipped = 0;
    for (const d of out) {
      const page = d.sourcePageNumber ?? null;
      if (page == null) continue;
      // Single-page crops only — a cross-page stitch cannot be re-cut from one bbox on one page.
      const spanStart = (d as { spanPageStart?: number }).spanPageStart ?? page;
      const spanEnd = (d as { spanPageEnd?: number }).spanPageEnd ?? page;
      if (spanStart !== spanEnd) continue;
      const band = bands[String(page)];
      if (!band) continue;
      const bbox = toBBox(d.sourceCoordinates);
      if (!bbox) continue;
      const [headerBottom, footerTop] = band;
      let y0 = bbox.y0;
      let y1 = bbox.y1;
      if (headerBottom > 0 && y0 < headerBottom) y0 = headerBottom; // clip the repeated header off the top
      if (footerTop > 0 && y1 > footerTop) y1 = footerTop; // clip the repeated footer off the bottom
      if (y0 === bbox.y0 && y1 === bbox.y1) continue; // already inside the content band — keep engine crop
      if (y1 - y0 < 4) continue; // degenerate after clip — keep the engine crop rather than a sliver
      const pageImage = artifacts.pageImages[page - 1];
      if (!pageImage) continue;
      const words = (artifacts.wordsByPage[page - 1] ?? []).map((w) => ({ text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }));
      const recrop = await this.cropToY(pageImage, { x0: bbox.x0, y0, x1: bbox.x1, y1 } as BBox, y1, words);
      if (!recrop) continue;
      const key = `${io.figureKeyPrefix}/ts-q${d.questionNumber ?? d.position}-p${page}-chrome.png`;
      await io.putObject(key, recrop, 'image/png');
      d.questionSnapshotKey = key;
      d.sourceCoordinates = { x0: bbox.x0, y0, x1: bbox.x1, y1 };
      clipped += 1;
    }
    return clipped;
  }

  /**
   * HYBRID: EXTEND an already-valid TS crop to include options Python proved belong to the SAME
   * owner (its pre-delivery validator's active search found the missing options and returned their
   * bounded `recoveredRegions`). This is NOT a new crop and NOT a new ownership engine — TS only
   * WIDENS (same column, re-crop taller from the raw page) or STITCHES (other column / page, append
   * below) its existing crop. Strict guardrails:
   *   • only INCOMPLETE questions (a question with no recoveredRegions is untouched);
   *   • only when Python ownership is PROVEN (cropAllowed && nextQuestionSafe);
   *   • never past the next confirmed owner's marker (clamp + post-validate);
   *   • after extension, re-validate that no OTHER owner's number entered the crop — if it did,
   *     route ONLY that question to review (needsImageReview), never the whole document.
   * The Visual-Question UI, crop rendering and option rendering are unchanged — the crop image just
   * gets wider/taller. Returns {extended, reviewed}. Best-effort: any failure keeps the engine crop.
   */
  private async applyRecoveredOptionsToTsCrops(
    out: DeliverableDraft[],
    proposal: DocumentAnalysisProposal,
    artifacts: DeliveryArtifacts,
    io: DeliveryIO,
  ): Promise<{ extended: number; reviewed: number }> {
    let extended = 0;
    let reviewed = 0;

    // All OTHER owners' start anchors (page, column-x, y) from Python's number boxes — the boundary
    // set used both to CLAMP an extension and to VALIDATE it never swallowed a neighbour's number.
    type Anchor = { id: string; page: number; cx: number; y: number };
    const anchors: Anchor[] = [];
    for (const q of proposal.questions) {
      const nb = q.numberBox;
      if (nb && nb.length === 5) anchors.push({ id: q.id, page: nb[0], cx: (nb[1] + nb[3]) / 2, y: nb[2] });
    }
    // The nearest other-owner marker below `y` on `page` whose x sits inside [x0,x1] (same column).
    const nextOwnerY = (selfId: string, page: number, x0: number, x1: number, y: number): number | null => {
      let best: number | null = null;
      for (const a of anchors) {
        if (a.id === selfId || a.page !== page) continue;
        if (a.cx < x0 || a.cx > x1) continue;
        if (a.y <= y + 1) continue;
        if (best == null || a.y < best) best = a.y;
      }
      return best;
    };
    // True when some OTHER owner's marker sits inside the box (page, [x0,x1] × (yTop,yBot]).
    const ownerInside = (selfId: string, page: number, x0: number, x1: number, yTop: number, yBot: number): boolean =>
      anchors.some(
        (a) => a.id !== selfId && a.page === page && a.cx >= x0 && a.cx <= x1 && a.y > yTop + 1 && a.y <= yBot + 1,
      );

    for (const d of out) {
      if ((d as { invalidCrop?: boolean }).invalidCrop) continue; // already routed elsewhere
      const num = typeof d.questionNumber === 'number' ? d.questionNumber : null;
      const q =
        (num != null ? proposal.questions.find((qq) => qq.number === num) : undefined) ??
        this.matchProposalQuestion(d, proposal.questions) ??
        undefined;
      if (!q) continue;
      const regions = q.deliveryReport?.recoveredRegions ?? [];
      if (regions.length === 0) continue; // only INCOMPLETE questions carry recovered regions
      // OWNERSHIP must be PROVEN by Python before TS extends anything.
      const cropAllowed = q.cropAllowed ?? q.ownershipReport?.cropAllowed ?? true;
      const nextSafe = q.ownershipReport?.nextQuestionSafe ?? true;
      if (!cropAllowed || !nextSafe) continue;

      const base = toBBox(d.sourceCoordinates);
      const page = d.sourcePageNumber ?? null;
      if (!base || page == null) continue;
      const spanStart = (d as { spanPageStart?: number }).spanPageStart ?? page;
      const spanEnd = (d as { spanPageEnd?: number }).spanPageEnd ?? page;

      // Partition recovered regions: SAME page + horizontal overlap = same column → WIDEN;
      // everything else (other column / other page) → STITCH below.
      const overlapsX = (r: { x0: number; x1: number }): boolean => Math.min(base.x1, r.x1) - Math.max(base.x0, r.x0) > 0;
      const widenRegions = regions.filter((r) => r.page === page && overlapsX(r));
      const stitchRegions = regions.filter((r) => !(r.page === page && overlapsX(r)));

      let curBBox: BBox = { ...base };
      let curImage: Buffer | null = null;
      let unsafe = false;
      let didExtend = false;

      // ── WIDEN (same column, single-page crops only — a stitched cross-page crop is left alone) ──
      if (widenRegions.length > 0 && spanStart === spanEnd) {
        const pageImage = artifacts.pageImages[page - 1];
        if (pageImage) {
          const nx0 = Math.min(base.x0, ...widenRegions.map((r) => r.x0));
          const nx1 = Math.max(base.x1, ...widenRegions.map((r) => r.x1));
          let ny1 = Math.max(base.y1, ...widenRegions.map((r) => r.y1));
          // CLAMP to just above the next confirmed owner in this column (never extend into it).
          const nextY = nextOwnerY(q.id, page, nx0, nx1, base.y0);
          if (nextY != null) ny1 = Math.min(ny1, nextY - 2);
          if (ny1 > base.y1 + 2 || nx0 < base.x0 - 2 || nx1 > base.x1 + 2) {
            // VALIDATE: the widened area must not contain another owner's number.
            if (ownerInside(q.id, page, nx0, nx1, base.y1, ny1)) {
              unsafe = true;
            } else {
              const words = (artifacts.wordsByPage[page - 1] ?? []).map((w) => ({ text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }));
              const newBBox: BBox = { x0: nx0, y0: base.y0, x1: nx1, y1: ny1 };
              const recrop = await this.cropToY(pageImage, newBBox, ny1, words);
              if (recrop) {
                curImage = recrop;
                curBBox = newBBox;
                didExtend = true;
              }
            }
          }
        }
      }

      // ── STITCH (other column / other page) — append each region crop below the current crop ──
      if (!unsafe && stitchRegions.length > 0) {
        const parts: Buffer[] = [];
        for (const r of [...stitchRegions].sort((a, b) => a.page - b.page || a.y0 - b.y0)) {
          const img = artifacts.pageImages[r.page - 1];
          if (!img) continue;
          // VALIDATE: the region must not contain another owner's number (Python bounded it, double-check).
          if (ownerInside(q.id, r.page, r.x0, r.x1, r.y0 - 1, r.y1)) {
            unsafe = true;
            break;
          }
          const words = (artifacts.wordsByPage[r.page - 1] ?? []).map((w) => ({ text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }));
          const part = await this.cropToY(img, { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 } as BBox, r.y1, words);
          if (part) parts.push(part);
        }
        if (!unsafe && parts.length > 0) {
          try {
            let acc = curImage ?? (d.questionSnapshotKey ? await io.getObject(d.questionSnapshotKey) : null);
            if (acc) {
              for (const p of parts) acc = await stitchVertical(acc, p);
              curImage = acc;
              didExtend = true;
            }
          } catch (err) {
            this.logger.warn(`recovered-options stitch failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      if (unsafe) {
        // The extension would have pulled in a neighbour — route ONLY this question to review.
        (d as { needsImageReview?: boolean }).needsImageReview = true;
        (d as { invalidCrop?: boolean }).invalidCrop = true;
        (d as { structuralReview?: string[] }).structuralReview = [
          ...((d as { structuralReview?: string[] }).structuralReview ?? []),
          'recovered_extension_unsafe',
        ];
        reviewed += 1;
        continue;
      }

      if (didExtend && curImage) {
        const key = `${io.figureKeyPrefix}/ts-q${d.questionNumber ?? d.position}-p${page}-recovered.png`;
        await io.putObject(key, curImage, 'image/png');
        d.questionSnapshotKey = key;
        d.sourceCoordinates = curBBox;
        // The crop now shows the full option set — reflect Python's recovered count so the
        // downstream option-clip check does not then route a now-complete question to review.
        const pyOpt = q.optionCount ?? 0;
        const cur = (d as { optionCount?: number }).optionCount ?? 0;
        if (pyOpt > cur) (d as { optionCount?: number }).optionCount = pyOpt;
        extended += 1;
      }
    }

    return { extended, reviewed };
  }

  /**
   * PER-QUESTION VALIDATION REPORT — Python is the validation authority; TS prints exactly which
   * checks passed for EVERY delivered question (golden rule #9: never silently deliver). One block,
   * one line per question. Fields are derived from Python's proposal (ownership heatmap, multiColumn/
   * multiPage flags, chromeBands, recovered list) matched to the TS draft by question number, then by
   * page + vertical overlap. Logging only — it never changes a draft.
   */
  private logQuestionValidationReport(out: DeliverableDraft[], proposal: DocumentAnalysisProposal): void {
    type Heat = DocumentAnalysisProposal['ownershipHeatmap'][number];
    const heatByNum = new Map<number, Heat>();
    for (const h of proposal.ownershipHeatmap ?? []) if (h.number != null) heatByNum.set(h.number, h);
    const recovered = new Set(proposal.questionCount?.recoveredQuestions ?? []);
    const visual = (h: Heat | undefined, kind: string): string => (h && h.checks?.[kind] === 'FAIL' ? 'FAIL' : 'PASS');
    const lines: string[] = [];
    for (const d of out) {
      const num = typeof d.questionNumber === 'number' ? d.questionNumber : null;
      const q =
        num != null
          ? proposal.questions.find((qq) => qq.number === num)
          : this.matchProposalQuestion(d, proposal.questions) ?? undefined;
      const h = num != null ? heatByNum.get(num) : undefined;
      const page = d.sourcePageNumber ?? q?.startPage ?? '-';
      const band = proposal.chromeBands?.[String(page)];
      const ownership = h
        ? h.checks?.question_number === 'PASS' && h.checks?.question_text === 'PASS'
          ? 'PASS'
          : 'FAIL'
        : q?.complete
          ? 'PASS'
          : 'FAIL';
      const review = (d as { invalidCrop?: boolean }).invalidCrop === true;
      const reasons = (d as { structuralReview?: string[] }).structuralReview ?? [];
      const optClipped = reasons.includes('option_clipped');
      const opt = (d as { optionCount?: number }).optionCount ?? 0;
      const verdict = !review && ownership === 'PASS' ? 'PASS' : 'FAIL';
      lines.push(
        `Q${num ?? '?'} p${page} Ownership=${ownership} ` +
          `Header=${band && band[0] > 0 ? 'Y' : 'N'} Footer=${band && band[1] > 0 ? 'Y' : 'N'} ` +
          `CrossPage=${q?.multiPage ? 'Y' : 'N'} CrossColumn=${q?.multiColumn ? 'Y' : 'N'} ` +
          `Neighbor=${h && (h.ownershipConflicts?.length ?? 0) > 0 ? 'LEAK' : 'OK'} ` +
          `Options=${opt}${optClipped ? '(CLIPPED)' : ''} ` +
          `Diagram=${visual(h, 'diagram')} Table=${visual(h, 'table')} Equation=${visual(h, 'equation')} ` +
          `Chemical=${visual(h, 'chemical_structure')} ` +
          `HandwrittenRecovered=${num != null && recovered.has(num) ? 'Y' : 'N'} ` +
          `Crop=${review ? 'FAIL' : 'PASS'} → ${verdict}`,
      );
    }
    this.logger.log(
      `\n===== PER-QUESTION VALIDATION (TS owns crops · Python validates) =====\n${lines.join('\n')}\n` +
        `=====================================================================`,
    );
  }

  /**
   * UPLOAD-LEVEL VALIDATION REPORT — one block per upload with every count + anomaly the architecture
   * requires (page count, logical / ownership / crop / delivered counts, missing / recovered numbers,
   * duplicates, Question-0, impossible sequences, cross-page / cross-column issues, header/footer
   * removals, watermark removals, detached options, PASS/FAIL). Derived from Python's proposal + the
   * TS-delivered set. Logging only — never changes a draft. Background removal is OFF so watermark
   * removals is always 0; header/footer removals reflect the content-safe chrome clips TS applied.
   */
  private logUploadValidationReport(ctx: {
    out: DeliverableDraft[];
    proposal: DocumentAnalysisProposal;
    pageCount: number;
    headerFooterRemovals: number;
    detachedOptions: number;
    validationPass: boolean;
  }): void {
    const { out, proposal, pageCount, headerFooterRemovals, detachedOptions, validationPass } = ctx;
    const delivered = out.filter((d) => !(d as { invalidCrop?: boolean }).invalidCrop).length;
    const crossPage = proposal.questions.filter((q) => q.multiPage).length;
    const crossColumn = proposal.questions.filter((q) => q.multiColumn).length;
    const arr = (v: unknown[] | undefined): string => `[${(v ?? []).join(',')}]`;
    this.logger.log(
      `\n========== UPLOAD VALIDATION REPORT ==========\n` +
        `pageCount=${pageCount}\n` +
        `logicalQuestionCount=${proposal.questions.length}\n` +
        `ownershipCount=${proposal.questionCount?.ownershipCount ?? proposal.questions.length}\n` +
        `cropCount=${out.length}\n` +
        `deliveredCount=${delivered}\n` +
        `missingNumbers=${arr(proposal.questionCount?.missingQuestions)}\n` +
        `recoveredNumbers=${arr(proposal.questionCount?.recoveredQuestions)}\n` +
        `duplicateQuestions=${arr(proposal.sequence?.duplicates)}\n` +
        `questionZero=${proposal.sequence?.questionZero ?? false}\n` +
        `impossibleSequences=${proposal.sequence?.impossible?.length ?? 0}\n` +
        `crossPageIssues=${crossPage}\n` +
        `crossColumnIssues=${crossColumn}\n` +
        `headerFooterRemovals=${headerFooterRemovals}\n` +
        `watermarkRemovals=0 (background removal OFF — content-safe chrome only)\n` +
        `detachedOptions=${detachedOptions}\n` +
        `RESULT=${validationPass ? 'PASS' : 'FAIL'}\n` +
        `==============================================`,
    );
  }

  /**
   * STRICT OPTION-OWNERSHIP VALIDATOR (Problem 3 — C/D clipping). A SINGLE_CHOICE / MCQ question is
   * complete only when it carries its FULL option set; a crop showing only A/B (or only C/D) is a
   * half-question and must route to REVIEW, never be delivered. We never assume "4" — the expected
   * count is the PAPER'S OWN modal option count (value-free, universal): most MCQs share it (NEET = 4),
   * so an MCQ below it lost options to a bad column / cross-page split. Per-question flag (individual
   * review), never a trim/rebuild. Skips papers with no dominant ≥4-option format so 3-option / mixed /
   * descriptive papers are never over-reviewed. Returns the flagged count + the modal used.
   */
  private flagClippedOptions(out: DeliverableDraft[]): { flagged: number; modal: number } {
    const counts = out
      .map((d) => (d as { optionCount?: number }).optionCount ?? 0)
      .filter((n) => n >= 2);
    if (counts.length < 3) return { flagged: 0, modal: 0 }; // too few MCQs to establish a reliable mode
    const freq = new Map<number, number>();
    for (const n of counts) freq.set(n, (freq.get(n) ?? 0) + 1);
    let modal = 0;
    let modalFreq = 0;
    for (const [n, f] of freq) if (f > modalFreq || (f === modalFreq && n > modal)) { modal = n; modalFreq = f; }
    if (modal < 4 || modalFreq < counts.length * 0.6) return { flagged: 0, modal }; // no dominant 4-option format
    let flagged = 0;
    for (const d of out) {
      const cls = (d as { questionClass?: string }).questionClass;
      const opt = (d as { optionCount?: number }).optionCount ?? 0;
      // An MCQ-class question (it HAS an option block) carrying FEWER than the modal count is clipped
      // (e.g. A/B only, or C/D only) ⇒ review. A non-MCQ (diagram / descriptive, 0–1 options) is left
      // alone. optionCount is the count across the WHOLE owned crop — we never validate one side only.
      if (cls === 'MCQ' && opt >= 2 && opt < modal && !(d as { needsImageReview?: boolean }).needsImageReview) {
        (d as { needsImageReview?: boolean }).needsImageReview = true;
        (d as { invalidCrop?: boolean }).invalidCrop = true;
        (d as { structuralReview?: string[] }).structuralReview = ['option_clipped'];
        flagged += 1;
      }
    }
    return { flagged, modal };
  }

  /** Quick reachability probe for the Python sidecar (/healthz). Returns false on any error / timeout —
   *  used to FAIL FAST instead of hanging the heavy analyze call when the sidecar is down or starting. */
  private async pingSidecar(serviceUrl: string, timeoutMs: number): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${serviceUrl.replace(/\/+$/, '')}/healthz`, { signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async applyStructuralProposal(
    out: DeliverableDraft[],
    artifacts: DeliveryArtifacts,
    io: DeliveryIO,
  ): Promise<{ added: number; stop: boolean; ran: boolean; logical?: number; crop?: number; verdict?: string }> {
    const sset = readStructureAnalyzeSettings();
    if (!sset.enabled || !sset.serviceUrl) return { added: 0, stop: false, ran: false, verdict: 'NO_SIDECAR_URL' };
    try {
      // SINGLE token path — the SAME `{words + page dims}` payload for every PDF (scanned / digital /
      // mixed). No special-casing by source type; the only difference is that TS OCR produced these
      // tokens upstream. This is the one production path Python reasons over.
      const pages = await this.buildAnalyzePages(artifacts);
      if (pages.length === 0) return { added: 0, stop: false, ran: false, verdict: 'NO_OCR_WORDS' };

      // FAIL FAST when the sidecar is down or still STARTING (e.g. right after a `npm run dev` restart —
      // the port may be bound but the app not yet ready, which would otherwise hang the heavy analyze
      // call up to its 180s timeout). A quick /healthz ping detects it in ~3s; we then skip building the
      // large render payload entirely and degrade with a CLEAR log, so the job never *looks* frozen.
      const healthy = await this.pingSidecar(sset.serviceUrl, 3000);
      if (!healthy) {
        this.logger.warn(
          `[python] sidecar ${sset.serviceUrl} NOT reachable (down or still starting?) — skipping analyze ` +
            `this run. Ensure the Python sidecar on :8002 is up (npm run dev) and re-upload.`,
        );
        return { added: 0, stop: false, ran: false, verdict: 'SIDECAR_DOWN' };
      }

      // Attach the page renders (base64, same coord space as the words) so Python can CV-detect badge /
      // seal question numbers the OCR could not read (white-on-black) and inject them into the count +
      // ownership. Content-safe + count-only: Python still proposes, TS still crops + persists.
      let payloadBytes = 0;
      for (const p of pages) {
        const buf = artifacts.pageImages[p.index - 1];
        if (buf) {
          const b64 = buf.toString('base64');
          (p as { imageBase64?: string }).imageBase64 = b64;
          payloadBytes += b64.length;
        }
      }

      const analyzeT0 = Date.now();
      // VISIBILITY: log when the Python analyze STARTS (with page count + payload size) so a long badge-
      // OCR pass on a scanned doc is clearly "running", not "stuck". Pairs with python_analyze_complete.
      this.logger.log(
        `[ocr-timing] python_analyze_started pages=${pages.length} payload=${(payloadBytes / 1048576).toFixed(1)}MB (badge OCR on scanned pages can take a while)`,
      );
      // ── DOCUMENT CLASSIFIER (automatic, evidence-based, engine-agnostic) ───────────────────────────
      // Pass 1 runs on the PLATFORM (Tesseract) tokens — the fast DIGITAL path. The document's own
      // characteristics then classify it: a DIGITAL doc comes back fully numbered (no gaps); a SCANNED doc
      // comes back severely under-detected (the platform OCR dropped numbers + option labels). When the
      // evidence says SCANNED and page renders are present, Pass 2 re-runs with ocrMode='scanned' so the
      // Python engine re-OCRs the renders with RapidOCR — a far longer pass, so it gets a generous timeout
      // (this runs inside the async OCR worker, never an API request, so there is no HTTP-request timeout to
      // hit). This is the "classifier → OCR selection" stage; the ownership/crop/validation engine that
      // follows is identical for both. No file names, no env flags — pure document evidence.
      let proposal = await analyzeDocumentHttp(
        { documentId: io.figureKeyPrefix, pages, ocrMode: 'digital' },
        { serviceUrl: sset.serviceUrl, timeoutMs: sset.timeoutMs },
      );
      const _scanned = this.looksScanned(proposal);
      if (_scanned && pages.some((p) => (p as { imageBase64?: string }).imageBase64)) {
        const scanTimeout = Math.max(sset.timeoutMs, 600_000); // RapidOCR re-OCR ~10s/page; worker is async
        this.logger.log(
          `[ocr-classify] document classified SCANNED (platform OCR under-read: ` +
            `logical=${proposal?.questionCount?.logicalQuestionCount ?? 0} ` +
            `expected=${proposal?.questionCount?.expectedCount ?? 0} ` +
            `missing=${proposal?.questionCount?.missingQuestions?.length ?? 0}) — re-OCR via RapidOCR ` +
            `(timeout=${scanTimeout}ms)`,
        );
        const rescan = await analyzeDocumentHttp(
          { documentId: io.figureKeyPrefix, pages, ocrMode: 'scanned' },
          { serviceUrl: sset.serviceUrl, timeoutMs: scanTimeout },
        );
        // Keep the re-OCR result only when it actually recovered more (never regress the digital pass).
        if (rescan && Array.isArray(rescan.questions) &&
            (rescan.questions.length > (proposal?.questions?.length ?? 0))) {
          proposal = rescan;
        }
      }
      this.logger.log(`[ocr-timing] python_analyze_complete +${Date.now() - analyzeT0}ms questions=${proposal?.questions?.length ?? 0}`);
      if (!proposal || !Array.isArray(proposal.questions))
        return { added: 0, stop: false, ran: true, verdict: 'SIDECAR_NO_PROPOSAL' };

      // ── HYBRID ARCHITECTURE (default): TS OWNS CROPS, Python is INTELLIGENCE-ONLY. ──────────────
      // The engine's reconciled TS crops in `out` are the delivered basis — Python NEVER re-crops or
      // replaces them. Python only (a) supplies header/footer `chromeBands` which TS clips from its
      // OWN crops, and (b) VALIDATES the set (ownership / count / sequence / integrity). Any Python
      // disagreement routes the whole document to REVIEW (golden rule: never silently deliver wrong),
      // but TS's count is NEVER swapped for Python's. See `tsOwnsCropsEnabled`.
      if (tsOwnsCropsEnabled()) {
        const clipT0 = Date.now();
        const clipped = await this.applyChromeBandsToTsCrops(out, proposal, artifacts, io);
        this.logger.log(`[ocr-timing] chrome_band_clip_complete +${Date.now() - clipT0}ms clipped=${clipped}/${out.length}`);

        // RECOVERED-OPTION CROP EXTENSION — before the clip check, WIDEN/STITCH a TS crop to the
        // options Python proved belong to the same owner (its active search → recoveredRegions), so
        // a question whose C/D spilled to the next column/page is delivered COMPLETE instead of
        // clipped. Ownership-gated + next-owner-clamped + post-validated; an unsafe extension routes
        // only that question to review. TS widens its OWN crop — Python never re-crops.
        const ext = await this.applyRecoveredOptionsToTsCrops(out, proposal, artifacts, io);
        if (ext.extended || ext.reviewed)
          this.logger.log(`[ocr-timing] recovered_options_extend complete extended=${ext.extended} reviewed=${ext.reviewed}/${out.length}`);

        // STRICT OPTION OWNERSHIP (Problem 3) — per-question: an MCQ below the paper's modal option
        // count lost its C/D (a half-question) ⇒ route THAT question to review. Independent of the
        // whole-document N=N=C gate below; it only flags individual clipped questions.
        const optionCheck = this.flagClippedOptions(out);

        // SUPPLEMENT GAP-FILL — inject Python-boundary crops for questions TS missed entirely.
        // TS crops are PRIMARY and never replaced. When Python detects a question (e.g. badge/seal
        // Q-number the TS OCR couldn't read, like PHYCHE Q28/Q29) that has no TS draft at all,
        // render it at Python's own crop boundary and inject into `out`.
        // Guard: no structural violations (no duplicate question numbers, no Question-0).
        // Integrity STOP from N≠C alone (some questions need review but crops are valid) does NOT
        // block supplement — that is a quality gate, not a structural-break. Python's per-question
        // `deliverable` field is the single authority for whether a crop is safe to inject.
        // Papers where TS already delivers the full set (e.g. download.pdf 180/180) produce zero
        // misses → supplement does nothing → no performance impact.
        const _suppDups = proposal.sequence?.duplicates?.length ?? 0;
        const _suppQ0   = proposal.sequence?.questionZero ?? false;
        if (_suppDups === 0 && !_suppQ0) {
          const tsNumbers = new Set(out.map(d => d.questionNumber).filter((n): n is number => n != null));
          const missed = (proposal.questions ?? []).filter(q =>
            typeof q.number === 'number' && q.number >= 1 &&
            !tsNumbers.has(q.number) &&
            q.deliverable === true,
          );
          if (missed.length > 0) {
            this.logger.log(
              `[supplement] TS missed ${missed.length} question(s) Python detected: ` +
              `[${missed.map(q => q.number).join(',')}] — rendering Python-boundary crops`,
            );
            const extras: DeliverableDraft[] = [];
            for (const q of missed) {
              try {
                const draft = await this.renderOneProposalCrop(q, out.length + extras.length, proposal, artifacts, io);
                if (draft) extras.push(draft);
              } catch (err) {
                this.logger.warn(`[supplement] Q${q.number} render failed (skipped): ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            if (extras.length) {
              out.push(...extras);
              out.sort((a, b) => (a.questionNumber ?? 999999) - (b.questionNumber ?? 999999));
              out.forEach((d, i) => { d.position = i; });
              this.logger.log(`[supplement] injected ${extras.length} crop(s) → total delivered=${out.length}`);
            }
          }
        }

        // CROP CORRECTNESS > COUNT CORRECTNESS (user priority 2026-06-24). A CORRECT crop must NOT be
        // held back just because Python's number detection lagged TS's crop — e.g. a badge / circled /
        // handwritten number Python declared "missing" but TS cropped perfectly. So whole-document review
        // fires ONLY on a STRUCTURAL break that makes the crops themselves unreliable: Python integrity
        // STOP (ownership conflict), a DUPLICATE number (two crops claim one question), Question-0 (a
        // phantom owner) or NOTHING delivered. A pure count discrepancy (logical/ownership vs delivered)
        // is REPORTED LOUDLY (never silent) but never blocks a page of correct crops. Per-question crop
        // problems (option clipping) are already routed to review individually above.
        const logicalN = proposal.questions.length;
        const ownershipN = proposal.questionCount?.ownershipCount ?? logicalN;
        const delivered = out.length;
        const dup = proposal.sequence?.duplicates?.length ?? 0;
        const q0 = proposal.sequence?.questionZero ?? false;
        const integrityStop = proposal.integrity?.status === 'STOP';
        const structuralBreak = integrityStop || dup > 0 || q0 || delivered === 0;
        const countDiscrepancy = logicalN !== delivered || ownershipN !== delivered;
        const validationPass = !structuralBreak;

        let added = 0;
        if (!validationPass) {
          for (const d of out) {
            if ((d as { needsImageReview?: boolean }).needsImageReview) continue;
            (d as { needsImageReview?: boolean }).needsImageReview = true;
            (d as { invalidCrop?: boolean }).invalidCrop = true;
            (d as { structuralReview?: string[] }).structuralReview = ['python_structural_break'];
            added += 1;
          }
        }

        // PER-QUESTION VALIDATION REPORT (golden rule: never silently deliver — name every check).
        this.logQuestionValidationReport(out, proposal);
        // UPLOAD-LEVEL VALIDATION REPORT — the full count/anomaly summary for this upload.
        this.logUploadValidationReport({
          out,
          proposal,
          pageCount: artifacts.pageImages.length,
          headerFooterRemovals: clipped,
          detachedOptions: optionCheck.flagged,
          validationPass,
        });
        this.logger.log(
          `python-validate (TS owns crops): logical=${logicalN} ownership=${ownershipN} ` +
            `delivered=${delivered} dup=${dup} q0=${q0} integrity=${proposal.integrity?.status ?? 'n/a'} ` +
            `reco=${proposal.recommendation} chromeClipped=${clipped} ` +
            `optionClipped=${optionCheck.flagged}(modal=${optionCheck.modal}) ` +
            `countDiscrepancy=${countDiscrepancy}${countDiscrepancy ? ` (logical${logicalN}≠delivered${delivered} — crops kept, count reported not blocked)` : ''} ` +
            `structuralBreak=${structuralBreak} ` +
            `verdict=${validationPass ? 'DELIVER' : 'REVIEW'} tiers=${this.tierSummary(proposal.questions)} ` +
            `missing=${proposal.questionCount?.missingQuestions?.length ?? 0}`,
        );
        return {
          // `added` (whole-doc review) + per-question option-clip flags both count as review-flagged.
          added: added + optionCheck.flagged,
          stop: !validationPass,
          ran: true,
          logical: logicalN,
          crop: delivered,
          verdict: validationPass ? 'DELIVER' : 'REVIEW',
        };
      }

      // ── LEGACY (OCR_TS_OWNS_CROPS=off): PYTHON IS THE SINGLE AUTHORITY. Python's question set is the
      // persisted basis: TS renders one crop per Python question at PYTHON'S OWN crop boundary (so the
      // set carries Python's count — e.g. 50, not TS's 48 — and a Python-recovered badge question with
      // no TS draft still gets a crop from the page image). TS's own draft count is informational only.
      const renderT0 = Date.now();
      const tsCrops = await this.renderProposalCrops(proposal, artifacts, io);
      this.logger.log(`[ocr-timing] crop_render_complete +${Date.now() - renderT0}ms crops=${tsCrops?.length ?? 0}`);
      const tsInformational = out.length;
      if (tsCrops && tsCrops.length) {
        out.length = 0;
        out.push(...tsCrops);
      }

      // THE SINGLE DELIVERY GATE — Expected == Logical == Ownership == Crop == Delivered, plus Python
      // ACCEPT and integrity not STOP. Any unmet equality routes the WHOLE document to review (repair
      // happens inside Python; review is last resort). TS never substitutes its own count.
      const qc = proposal.questionCount;
      const logicalN = proposal.questions.length;
      const expected = qc?.expectedCount ?? logicalN;
      const ownershipN = qc?.ownershipCount ?? logicalN;
      const completeC = proposal.questions.filter((q) => q.complete && !q.needsReview).length;
      const cropCount = tsCrops?.length ?? 0;
      const delivered = out.length;
      const chainEqual =
        expected === logicalN &&
        logicalN === ownershipN &&
        ownershipN === completeC &&
        completeC === cropCount &&
        cropCount === delivered &&
        delivered > 0;
      const deliverClean =
        proposal.recommendation === 'ACCEPT' && proposal.integrity?.status !== 'STOP' && chainEqual;

      let added = 0;
      if (!deliverClean) {
        // Keep Python's rendered set, but flag EVERY crop for review (whole document → review).
        for (const d of out) {
          if ((d as { needsImageReview?: boolean }).needsImageReview) continue;
          (d as { needsImageReview?: boolean }).needsImageReview = true;
          (d as { invalidCrop?: boolean }).invalidCrop = true;
          (d as { structuralReview?: string[] }).structuralReview = ['nnc_chain_unmet'];
          added += 1;
        }
      }
      this.logger.log(
        `python-authority: expected=${expected} logical=${logicalN} ownership=${ownershipN} ` +
          `complete=${completeC} crop=${cropCount} delivered=${delivered} ` +
          `verdict=${deliverClean ? 'DELIVER' : 'REVIEW'} reco=${proposal.recommendation} ` +
          `integrity=${proposal.integrity?.status ?? 'n/a'} tsInformational=${tsInformational} ` +
          `dup=${proposal.sequence?.duplicates?.length ?? 0} q0=${proposal.sequence?.questionZero ?? false} ` +
          `missing=${proposal.questionCount?.missingQuestions?.length ?? 0} ` +
          `tiers=${this.tierSummary(proposal.questions)}`,
      );
      // Handwritten-number RECOVERY summary (Python runs handwritten OCR ONLY on numbering gaps). regions=0
      // means it never ran over already-detected content — the expected state when numbering is contiguous.
      const hwr = (
        proposal.questionCount as { handwrittenRecovery?: Record<string, unknown> } | undefined
      )?.handwrittenRecovery;
      if (hwr) {
        const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
        const gt = (hwr.gapTypes ?? {}) as Record<string, { regionsProcessed?: number; recovered?: unknown[] }>;
        const t = (k: string): string =>
          `${k}(regions=${gt[k]?.regionsProcessed ?? 0},rec=[${arr(gt[k]?.recovered).join(',')}])`;
        this.logger.log(
          `handwritten-recovery: expected=${hwr.expectedQuestions} tesseract=${hwr.tesseractQuestions} ` +
            `missing=${arr(hwr.missingQuestions).length} executed=${hwr.handwrittenOcrExecuted} ` +
            `regionsProcessed=${hwr.handwrittenOcrRegionsProcessed} ` +
            `recovered=[${arr(hwr.recoveredQuestions).join(',')}] | ` +
            `${t('IN_COLUMN')} ${t('CROSS_COLUMN')} ${t('CROSS_PAGE')}`,
        );
      }
      return { added, stop: !deliverClean, ran: true, logical: logicalN, crop: cropCount,
        verdict: deliverClean ? 'DELIVER' : 'REVIEW' };
    } catch (err) {
      this.logger.warn(`python intelligence skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      return { added: 0, stop: false, ran: false, verdict: 'ERROR' };
    }
  }

  /** Compact decision-matrix tier histogram for the delivery log: TS_LIGHTWEIGHT / TS_FULL / REVIEW. */
  private tierSummary(questions: ProposalQuestion[]): string {
    let light = 0;
    let full = 0;
    let review = 0;
    for (const q of questions) {
      if (q.tier === 'TS_LIGHTWEIGHT') light += 1;
      else if (q.tier === 'TS_FULL') full += 1;
      else review += 1;
    }
    return `L${light}/F${full}/R${review}`;
  }

  /** Map an emitted draft to a flagged Python question by page + vertical overlap of its source bbox. */
  private matchProposalQuestion(
    d: DeliverableDraft,
    flagged: ProposalQuestion[],
  ): ProposalQuestion | null {
    const page = d.sourcePageNumber ?? null;
    const c = d.sourceCoordinates ?? null;
    if (page == null) return null;
    for (const q of flagged) {
      if (page < q.startPage || page > q.endPage) continue;
      const boxes = q.boxes.filter((b) => b.page === page);
      if (boxes.length === 0) continue;
      if (!c) return q; // no draft bbox ⇒ page-level match is enough
      for (const b of boxes) {
        const top = Math.max(c.y0, b.y0);
        const bot = Math.min(c.y1, b.y1);
        const inter = Math.max(0, bot - top);
        const smaller = Math.max(1, Math.min(c.y1 - c.y0, b.y1 - b.y0));
        if (inter / smaller >= 0.4) return q;
      }
    }
    return null;
  }

  /** Re-crop the page image to the locked trim boundary (Question+Options only). Also applies the
   *  SAME final-crop finalisation the engine does — deterministic question-number strip + generic
   *  background lift — so a trimmed re-crop is byte-consistent with engine crops (no number, no grey
   *  texture). Best-effort. */
  private async cropToY(
    pageImage: Buffer, bbox: BBox, trimY: number,
    words: ReadonlyArray<{ text: string; x0: number; y0: number; x1: number; y1: number }>,
  ): Promise<Buffer | null> {
    try {
      // RAW-CONTENT mode (OCR_CROP_RAW_CONTENT=true): crop straight from the page render with NO
      // divider-clean and NO background lift — the crop shows EXACTLY what is in the PDF (no colour
      // change, no content damage). The client strips the background downstream (Adobe). The printed
      // question-number strip still runs (it removes a number, not content). Default keeps the
      // divider-clean + background-lift behaviour.
      const rawContent = process.env.OCR_CROP_RAW_CONTENT === 'true';
      // Remove the column divider on the page FIRST (memoised), so this delivered re-crop matches
      // the engine's divider-cleaned crops instead of carrying the divider from the raw page.
      const src = rawContent ? pageImage : await this.cleanedPageSource(pageImage);
      const meta = await sharp(src).metadata();
      const W = meta.width ?? 0;
      const H = meta.height ?? 0;
      const left = Math.max(0, Math.round(bbox.x0));
      const top = Math.max(0, Math.round(bbox.y0));
      const width = Math.min(W - left, Math.round(bbox.x1 - bbox.x0));
      const height = Math.min(H - top, Math.round(trimY - bbox.y0));
      if (width <= 0 || height <= 0) return null;
      let out = await sharp(src).extract({ left, top, width, height }).png().toBuffer();
      // REQ 1 — strip the printed question number from this re-crop (origin = bbox top-left).
      const region = words.filter((w) => w.x0 >= bbox.x0 - 2 && w.x1 <= bbox.x1 + 2 && w.y0 >= bbox.y0 - 2 && w.y1 <= trimY + 2);
      const lm = detectLeadingMarker(region as any);
      if (process.env.OCR_STRIP_QUESTION_NUMBER !== 'false' && lm) out = await whitenRegion(out, lm.box, lm.frac, bbox.x0, bbox.y0);
      // REQ 2 — generic background lift, same as engine crops. Skipped in RAW-CONTENT mode so the crop
      // keeps the document's exact pixels (no colour change / no faint-content damage).
      if (!rawContent) out = await liftBackground(out);
      return out;
    } catch (err) {
      this.logger.warn(`trim re-crop failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Region crop keys to stitch for a merged question, ordered top→bottom by region y0. */
  private memberCropKeys(
    drafts: ReadonlyArray<DeliverableDraft>,
    survivorIdx: number,
    mergedRegions: BBox[],
    keptIdx: Set<number>,
  ): string[] {
    const within = (c: BBox | undefined, r: BBox): boolean =>
      !!c && c.x0 >= r.x0 - 2 && c.y0 >= r.y0 - 2 && c.x1 <= r.x1 + 2 && c.y1 <= r.y1 + 2;
    const members: Array<{ key: string; y0: number }> = [];
    drafts.forEach((d, i) => {
      // survivor always included; absorbed = removed drafts whose region is inside a merged bbox
      const c = toBBox(d.sourceCoordinates);
      const isMember = i === survivorIdx || (!keptIdx.has(i) && mergedRegions.some((r) => within(c, r)));
      if (isMember && d.questionSnapshotKey) members.push({ key: d.questionSnapshotKey, y0: c?.y0 ?? 0 });
    });
    return members.sort((a, b) => a.y0 - b.y0).map((m) => m.key);
  }

  private async stitchCrops(keys: string[], io: DeliveryIO): Promise<Buffer | null> {
    if (keys.length === 0) return null;
    try {
      const buffers = await Promise.all(keys.map((k) => io.getObject(k)));
      let acc = buffers[0];
      for (let i = 1; i < buffers.length; i += 1) acc = await stitchVertical(acc, buffers[i]);
      return acc;
    } catch (err) {
      this.logger.warn(`merged-crop stitch failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}

const toBBox = (c: { x0: number; y0: number; x1: number; y1: number } | null | undefined): BBox | undefined => {
  if (!c || [c.x0, c.y0, c.x1, c.y1].some((v) => typeof v !== 'number')) return undefined;
  return { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 };
};
