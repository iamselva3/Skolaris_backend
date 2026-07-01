import { OcrAnalysisDeliveryService, DeliverableDraft } from './ocr-analysis-delivery.service';

/**
 * PRODUCTION-LEVEL completeness guard (P4). These assert the rules the user requires hold for ANY
 * unseen paper: a "Question 0" / orphan / out-of-sequence / duplicate / option-less MCQ crop must be
 * flagged for REVIEW (needsImageReview + invalidCrop), never delivered as a clean question; a complete
 * question must pass untouched. The validator is value-free (range derived from the paper's own count).
 */
const draft = (over: Partial<DeliverableDraft> & { optionCount?: number; questionClass?: string }): DeliverableDraft =>
  ({ position: 0, questionNumber: 1, optionCount: 4, questionClass: 'MCQ', ...over } as DeliverableDraft);
const flaggedFor = (d: DeliverableDraft): boolean =>
  !!(d as { needsImageReview?: boolean }).needsImageReview && !!(d as { invalidCrop?: boolean }).invalidCrop;

describe('OcrAnalysisDeliveryService.validateCompleteness (P4 pre-persist guard)', () => {
  it('FLAGS a "Question 0" orphan (number ≤ 0 / null) — never delivered as a question', () => {
    const zero = draft({ questionNumber: 0 });
    const nul = draft({ questionNumber: null });
    OcrAnalysisDeliveryService.validateCompleteness([draft({ questionNumber: 1 }), zero, nul]);
    expect(flaggedFor(zero)).toBe(true);
    expect(flaggedFor(nul)).toBe(true);
  });

  it('FLAGS an out-of-sequence phantom (e.g. 234 on a small paper) from broken options', () => {
    const set = Array.from({ length: 10 }, (_, i) => draft({ questionNumber: i + 1 }));
    const phantom = draft({ questionNumber: 234 });
    OcrAnalysisDeliveryService.validateCompleteness([...set, phantom]);
    expect(flaggedFor(phantom)).toBe(true);
  });

  it('FLAGS a DUPLICATE question number', () => {
    const a = draft({ questionNumber: 5 });
    const dup = draft({ questionNumber: 5 });
    OcrAnalysisDeliveryService.validateCompleteness([a, dup]);
    expect(flaggedFor(a)).toBe(false); // first occurrence is kept
    expect(flaggedFor(dup)).toBe(true);
  });

  it('FLAGS an MCQ with missing options (orphan stem / detached options)', () => {
    const noOpts = draft({ questionNumber: 7, optionCount: 1, questionClass: 'MCQ' });
    OcrAnalysisDeliveryService.validateCompleteness([noOpts]);
    expect(flaggedFor(noOpts)).toBe(true);
  });

  it('does NOT flag complete, in-sequence questions (no false review)', () => {
    const ok = Array.from({ length: 5 }, (_, i) => draft({ questionNumber: i + 1, optionCount: 4 }));
    const flagged = OcrAnalysisDeliveryService.validateCompleteness(ok);
    expect(flagged).toBe(0);
    expect(ok.every((d) => !flaggedFor(d))).toBe(true);
  });

  it('does NOT flag a complete diagram/descriptive question that legitimately has <2 option labels', () => {
    const diagram = draft({ questionNumber: 3, optionCount: 0, questionClass: 'DIAGRAM_BASED' });
    const descriptive = draft({ questionNumber: 4, optionCount: 0, questionClass: 'DESCRIPTIVE' });
    OcrAnalysisDeliveryService.validateCompleteness([diagram, descriptive]);
    expect(flaggedFor(diagram)).toBe(false);
    expect(flaggedFor(descriptive)).toBe(false);
  });
});
