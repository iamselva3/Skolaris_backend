import { Injectable } from '@nestjs/common';
import { detectQuestionPunct, hasStem, isCompleteBlock, medianHeight } from '../../shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../../shared/ocr-engine/column-reorder';
import { BBox, ExpandHook, Finding, PaperDetectorContext, ShadowDraft, ShadowWord } from './contracts';

/**
 * CROSS-PAGE CONTINUATION detection + EXPAND hook (Phase 9). Detector #6. It answers ONE question —
 * "does this logical question continue onto the next page?" — by inspecting the bottom region of
 * page N and the top region of page N+1. It owns ONLY the EXPAND stage.
 *
 * Phase 9 does NOT stitch (stitching changes counts — not allowed). It DETECTS, CLASSIFIES, EMITS
 * findings + an EXPAND hint, and routes uncertainty to review. The EXPAND hook is NO-OP. Value-free:
 * page boundaries + geometry + OCR structure + marker presence + option grammar.
 *
 * Continuation candidate only if ALL hold:
 *   1. page N ends with an INCOMPLETE question region (read-only isCompleteBlock = false),
 *   2. page N+1 begins with a MARKER-FREE region (no question number),
 *   3. page N+1 begins with option grammar OR continuation text,
 *   4. no new valid question marker starts first (⊆ rule 2 — the top region carries no marker).
 * Uncertain → NO-OP, never auto-stitch. Section headers / instructions / tables / diagrams / match
 * are protected: they carry a marker or are not option/continuation text → rule 2/3 fails.
 */
const OPTION_LEAD = /^\(?[A-Da-d][.)]|^\([1-4]\)/;
const lead = (s: string): string => (s ?? '').replace(/^["'`|.,;:_\s]+/, '');
const toBox = (w: ShadowWord): OcrWordBox => ({ text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 });
const regionWords = (words: OcrWordBox[], c: BBox): OcrWordBox[] =>
  words.filter((w) => {
    const cx = (w.x0 + w.x1) / 2;
    const cy = (w.y0 + w.y1) / 2;
    return cx >= c.x0 && cx < c.x1 && cy >= c.y0 && cy < c.y1;
  });

export const detectCrossPageContinuations = (ctx: PaperDetectorContext): Finding[] => {
  const byPage = new Map<number, ShadowDraft[]>();
  for (const d of ctx.drafts) {
    const g = byPage.get(d.page);
    if (g) g.push(d);
    else byPage.set(d.page, [d]);
  }
  const pages = [...byPage.keys()].sort((a, b) => a - b);
  const out: Finding[] = [];

  for (let i = 0; i + 1 < pages.length; i += 1) {
    const n = pages[i];
    const n1 = pages[i + 1];
    if (n1 !== n + 1) continue; // adjacent pages only

    const draftsN = byPage.get(n)!.filter((d) => d.coords);
    const draftsN1 = byPage.get(n1)!.filter((d) => d.coords);
    if (draftsN.length === 0 || draftsN1.length === 0) continue;

    const lastN = draftsN.reduce((a, b) => ((a.coords!.y1 >= b.coords!.y1) ? a : b));
    const firstN1 = draftsN1.reduce((a, b) => ((a.coords!.y0 <= b.coords!.y0) ? a : b));

    const wordsN = (ctx.wordsByPage[n - 1] ?? []).map(toBox);
    const qPunctN = detectQuestionPunct(wordsN, medianHeight(wordsN));
    const wordsN1 = (ctx.wordsByPage[n1 - 1] ?? []).map(toBox);
    const qPunctN1 = detectQuestionPunct(wordsN1, medianHeight(wordsN1));

    // rule 1 — page N's last region is incomplete (its options didn't fit on the page)
    const incomplete = !isCompleteBlock(regionWords(wordsN, lastN.coords!), qPunctN);
    // rule 3 — page N+1 begins with option grammar OR continuation text (lowercase start)
    const t = lead(firstN1.text);
    const continuationText = OPTION_LEAD.test(t) || /^[a-z]/.test(t);
    // ROOT-CAUSE FIX: the top region is a CONTINUATION (not a new question) when it does NOT start a
    // NEW numbered question. A new question carries its OWN question marker; a continuation (options
    // OR wrapped prose flowing from the previous page) does not. So treat as continuation when the
    // top region either has NO question number (true marker-less continuation — CASE 3/4) OR has a
    // spurious number but no real stem (engine mis-read an option value — the original split case),
    // and is NOT a valid sequential next question. A real new numbered question with its own stem is
    // therefore excluded → two separate questions stay two crops.
    const topHasStem = hasStem(regionWords(wordsN1, firstN1.coords!), qPunctN1);
    const topIsValidNext =
      typeof firstN1.questionNumber === 'number' && typeof lastN.questionNumber === 'number' &&
      firstN1.questionNumber === lastN.questionNumber + 1;
    const startsNewNumberedQuestion = typeof firstN1.questionNumber === 'number' && topHasStem;
    const isContinuation = continuationText && !topIsValidNext && !startsNewNumberedQuestion;

    if (incomplete && isContinuation) {
      out.push({
        detector: 'cross-page-continuation',
        kind: 'cross-page-candidate',
        target: { page: n1, draftIndex: firstN1.index, bbox: firstN1.coords },
        confidence: 0.7, // MEDIUM → review; never auto-stitch in Phase 9 (would change counts)
        evidence: { fromPage: n, fromDraft: lastN.index, toPage: n1, toDraft: firstN1.index, startsOption: OPTION_LEAD.test(t) },
        proposedCorrection: 'NONE',
      });
    }
  }
  return out;
};

/**
 * EXPAND-stage hook. Phase 9 does NOT stitch across pages (would change counts), so the hook returns
 * the region UNCHANGED (NO-OP). The stitch hint lives in the findings/review queue; applying it is a
 * later, separately-authorized step.
 */
@Injectable()
export class CrossPageExpandHook implements ExpandHook {
  readonly name = 'cross-page-continuation';

  adjustExpand(_draft: ShadowDraft, region: BBox, _ctx: PaperDetectorContext): BBox {
    return region; // never stitch / grow / shrink in Phase 9 — NO-OP, safe
  }
}
