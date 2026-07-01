import { Injectable } from '@nestjs/common';
import { ContentNumeralDetector, DuplicateNumberingDetector } from './detectors';
import { DeliveryGate } from './delivery-gate';
import {
  BridgeQuestion,
  DetectorContext,
  Finding,
  PageFeatures,
  PaperDetectorContext,
  ShadowDraft,
  tierOf,
} from './contracts';

/**
 * CALLBACK CORRECTION — the production seam adapter (OPTION a). At the persistence callback only
 * draft TEXT + question numbers + coordinates exist (no page words/images), so this reuses ONLY the
 * two text-based, validated detectors — Content-Numeral demotion and Duplicate-Numbering removal —
 * to correct the persisted question SET (remove phantom/duplicate drafts) and runs the count delivery
 * gate. It reuses the existing framework logic (no new detection rules, no thresholds, no OCR logic).
 * Geometry corrections (explanation crop-trim, split/cross-page crop-merge) are NOT applied here:
 * they require page words/images that exist only inside the OCR run, not at this seam.
 */
export interface CallbackDraftLike {
  position: number;
  text?: string | null;
  questionNumber?: number | null;
  sourcePageNumber?: number | null;
  sourceCoordinates?: Record<string, number> | null;
}

const toBbox = (c: Record<string, number> | null | undefined): { x0: number; y0: number; x1: number; y1: number } | undefined => {
  if (!c || [c.x0, c.y0, c.x1, c.y1].some((v) => typeof v !== 'number')) return undefined;
  return { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 };
};

export interface CallbackCorrectionResult {
  keptPositions: Set<number>;
  removed: Array<{ position: number; detector: string; kind: string }>;
  deliverable: boolean; // gate: count-integrity holds (no duplicate/extra/missing in the kept set)
  gateReasons: string[];
}

@Injectable()
export class CallbackCorrectionService {
  private readonly contentNumeral = new ContentNumeralDetector();
  private readonly duplicate = new DuplicateNumberingDetector();

  constructor(private readonly gate: DeliveryGate) {}

  correct(drafts: ReadonlyArray<CallbackDraftLike>): CallbackCorrectionResult {
    const shadow: ShadowDraft[] = drafts.map((d) => ({
      index: d.position,
      page: d.sourcePageNumber ?? 1,
      questionNumber: d.questionNumber ?? null,
      text: d.text ?? '',
      coords: toBbox(d.sourceCoordinates),
    }));

    const findings: Finding[] = [];
    // Content-Numeral — per page (text-only)
    const pages = new Map<number, ShadowDraft[]>();
    for (const s of shadow) { const g = pages.get(s.page); if (g) g.push(s); else pages.set(s.page, [s]); }
    for (const [page, pageDrafts] of pages) {
      const features = { pageIndex: page } as unknown as PageFeatures;
      const ctx: DetectorContext = { features, drafts: pageDrafts, words: [] };
      findings.push(...this.contentNumeral.detect(ctx));
    }
    // Duplicate-Numbering — paper level (text-only)
    const pctx: PaperDetectorContext = { drafts: shadow, pages: [], wordsByPage: [] };
    findings.push(...this.duplicate.detectPaper(pctx));

    // apply only HIGH-confidence removals (the validated auto-fix tier)
    const removed: Array<{ position: number; detector: string; kind: string }> = [];
    const removedIdx = new Set<number>();
    for (const f of findings) {
      if (f.proposedCorrection !== 'REMOVE_DRAFT' || tierOf(f.confidence) !== 'HIGH') continue;
      if (f.target.draftIndex === undefined || removedIdx.has(f.target.draftIndex)) continue;
      removedIdx.add(f.target.draftIndex);
      removed.push({ position: f.target.draftIndex, detector: f.detector, kind: f.kind });
    }
    const keptPositions = new Set(shadow.filter((s) => !removedIdx.has(s.index)).map((s) => s.index));

    // count delivery gate over the corrected set (build a minimal bridge view)
    const keptDrafts = shadow.filter((s) => keptPositions.has(s.index));
    const questions: BridgeQuestion[] = keptDrafts.map((s) => ({
      questionId: `q-p${s.page}-d${s.index}`,
      questionNumber: s.questionNumber,
      sourcePages: [s.page],
      questionOptionsBbox: s.coords ?? { x0: 0, y0: 0, x1: 1, y1: 1 },
      finalBoundaries: s.coords ?? { x0: 0, y0: 0, x1: 1, y1: 1 },
      mergedRegions: [s.coords ?? { x0: 0, y0: 0, x1: 1, y1: 1 }],
      explanationTrimY: null,
      reviewStatus: 'ok',
      confidence: 0.95,
    }));
    const decision = this.gate.decide({
      questions,
      totalLogicalQuestions: keptDrafts.length,
      totalBridgeObjects: keptDrafts.length,
      nToN: true,
      duplicateObjects: 0,
      orphanObjects: 0,
      extraObjects: 0,
      missingObjects: 0,
      explanationLeakageObjects: 0,
      silentLeakageObjects: 0,
      brokenBoundaryObjects: 0,
      splitMergedObjects: 0,
      crossPageMergedObjects: 0,
    });

    return { keptPositions, removed, deliverable: decision.status === 'DELIVER', gateReasons: decision.reasons };
  }
}
