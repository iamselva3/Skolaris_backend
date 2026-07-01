import { Injectable } from '@nestjs/common';
import { PaperStructure, SectionSpan, ShadowDraft } from './contracts';

/**
 * PAPER ANALYZER — derives whole-paper structure from the (already corrected) draft list:
 * page / marker / region / section structure, then the expected logical question count.
 *
 * Generic and value-free: NEVER hardcodes 180 / 120 / 70 / 30. It does NOT assume numbering starts
 * at 1, is contiguous, or never restarts — a "restart" (a number ≤ the previous one) legitimately
 * begins a new SECTION (multi-subject papers), and questions in each section are counted. One
 * well-formed draft = one logical question = one crop.
 */
@Injectable()
export class PaperAnalyzer {
  /** `drafts` should already have Content-Numeral HIGH phantoms removed (Phase 2 corrected set). */
  analyze(drafts: ReadonlyArray<ShadowDraft>, pageCount: number, numeralCount: number): PaperStructure {
    const sections = this.sections(drafts);
    return {
      pageCount,
      draftCount: drafts.length,
      numeralCount,
      sections,
      // derived from SECTION structure: sum of each section's question count (restart-aware).
      // Phantoms are already removed upstream, so this equals the corrected region count.
      expectedQuestionCount: sections.reduce((n, s) => n + s.count, 0),
    };
  }

  /** Split the draft stream into numbering sections at each restart (number ≤ previous). */
  private sections(drafts: ReadonlyArray<ShadowDraft>): SectionSpan[] {
    const spans: SectionSpan[] = [];
    let start = 0;
    let last: number | null = null;
    const close = (endExclusive: number): void => {
      if (endExclusive <= start) return;
      const slice = drafts.slice(start, endExclusive);
      const nums = slice.map((d) => d.questionNumber).filter((v): v is number => typeof v === 'number');
      spans.push({
        startDraftIndex: drafts[start].index,
        endDraftIndex: drafts[endExclusive - 1].index,
        firstNumber: nums[0] ?? null,
        lastNumber: nums[nums.length - 1] ?? null,
        count: slice.length,
      });
    };
    for (let i = 0; i < drafts.length; i += 1) {
      const n = drafts[i].questionNumber;
      if (typeof n === 'number' && last !== null && n <= last) {
        close(i); // restart → new section
        start = i;
      }
      if (typeof n === 'number') last = n;
    }
    close(drafts.length);
    return spans;
  }
}
