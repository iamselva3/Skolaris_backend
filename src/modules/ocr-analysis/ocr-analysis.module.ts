import { Module } from '@nestjs/common';
import { buildDetectors, DETECTORS } from './detectors';
import { PageAnalyzer } from './page-analyzer';
import { PaperAnalyzer } from './paper-analyzer';
import { CountReconciler } from './count-reconciler';
import { ReviewQueueRouter } from './review-queue';
import { QuestionLifecycleEngine } from './lifecycle';
import { MultiColumnStartHook } from './multi-column';
import { WideContentExpandHook } from './wide-content';
import { SplitQuestionExpandHook } from './split-question';
import { CrossPageExpandHook } from './cross-page';
import { HandwrittenStartHook } from './handwritten';
import { ExplanationFinalizeHook } from './explanation';
import { ShadowIntegrityValidator } from './integrity-validator';
import { CorrectionApplier } from './correction-applier';
import { EnterpriseValidator } from './enterprise-validation';
import { ProductionBridge } from './production-bridge';
import { DeliveryGate } from './delivery-gate';
import { CallbackCorrectionService } from './callback-correction';
import { OcrShadowAnalyzer } from './ocr-shadow-analyzer';
import { OcrAnalysisDeliveryService } from './ocr-analysis-delivery.service';

/**
 * OCR ENTERPRISE ARCHITECTURE — Phase 1 framework (SHADOW MODE), standalone observability.
 *
 * This module installs the Page Analyzer, the 8 (stub) detectors, the integrity validator, and
 * the shadow orchestrator. It is intentionally NOT wired into the OCR flow (no hook into
 * complete-upload / OcrJobRunner / the engine), so registering it changes NO OCR behaviour —
 * it only makes the framework available for a later, separately-authorized integration step.
 *
 * Nothing here imports `src/shared/ocr-engine/*`.
 */
@Module({
  providers: [
    PageAnalyzer,
    PaperAnalyzer,
    CountReconciler,
    ReviewQueueRouter,
    QuestionLifecycleEngine,
    MultiColumnStartHook,
    WideContentExpandHook,
    SplitQuestionExpandHook,
    CrossPageExpandHook,
    HandwrittenStartHook,
    ExplanationFinalizeHook,
    ShadowIntegrityValidator,
    CorrectionApplier,
    EnterpriseValidator,
    ProductionBridge,
    DeliveryGate,
    CallbackCorrectionService,
    { provide: DETECTORS, useFactory: () => buildDetectors() },
    OcrShadowAnalyzer,
    OcrAnalysisDeliveryService,
  ],
  exports: [OcrShadowAnalyzer, PageAnalyzer, PaperAnalyzer, EnterpriseValidator, ProductionBridge, DeliveryGate, CallbackCorrectionService, OcrAnalysisDeliveryService],
})
export class OcrAnalysisModule {}
