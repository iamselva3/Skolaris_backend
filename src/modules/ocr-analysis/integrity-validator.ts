import { Injectable } from '@nestjs/common';
import {
  classifyBlock,
  detectQuestionPunct,
  isCompleteBlock,
  medianHeight,
} from '../../shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../../shared/ocr-engine/column-reorder';
import { DetectorContext, IntegrityScore, IntegrityValidator, ShadowWord } from './contracts';

/**
 * QUESTION COMPLETION validator (the Question Integrity Validator stage). PHASE 3: real behavior
 * that REUSES the existing Session-3 Question+Options completion logic — the engine's EXPORTED,
 * read-only helpers `isCompleteBlock` / `classifyBlock` (it does NOT modify the engine and does NOT
 * build a second Q+O system). A question is complete when its block has a stem + options (or is a
 * descriptive/diagram/table/graph block with enough content). It establishes the COMPLETION
 * BOUNDARY (bottom of the last option line) — the boundary source the future Explanation Block
 * detector will reuse (PREP only; nothing is trimmed here).
 *
 * Routing is conservative: it NEVER edits a crop and routes to REVIEW only for an OPTION-ONLY
 * orphan (starts with option grammar, no question number). A completeness=false draft that still
 * has a question number is left PASS (the engine's completeness check false-negatives on sparse
 * OCR, so it must not flag real questions) — this keeps clean papers identical.
 */
const toBox = (w: ShadowWord): OcrWordBox => ({ text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 });
const OPTION_LABEL = /^\(?([A-Da-d])[.)]$|^\(([1-4])\)$/;
const OPTION_LEAD = /^\(?[A-Da-d][.)]|^\([1-4]\)/;

@Injectable()
export class ShadowIntegrityValidator implements IntegrityValidator {
  validate(ctx: DetectorContext): IntegrityScore[] {
    const pageWords = ctx.words.map(toBox);
    const mH = medianHeight(pageWords);
    const qPunct = detectQuestionPunct(pageWords, mH);

    return ctx.drafts.map((d) => {
      const c = d.coords;
      const rw = c
        ? pageWords.filter((w) => {
            const cx = (w.x0 + w.x1) / 2;
            const cy = (w.y0 + w.y1) / 2;
            return cx >= c.x0 && cx < c.x1 && cy >= c.y0 && cy < c.y1;
          })
        : pageWords;

      const complete = isCompleteBlock(rw, qPunct); // Session-3 completion (stem + options / descriptive)
      const cls = classifyBlock(rw, qPunct);

      // completion boundary = bottom of the last option-label line; figure/table blocks run to the
      // region bottom. null when no options found and no coords.
      const optionYs = rw.filter((w) => OPTION_LABEL.test(w.text)).map((w) => w.y1);
      const completeAtY = optionYs.length ? Math.max(...optionYs) : c ? c.y1 : null;

      const lead = (d.text ?? '').replace(/^["'`|.,;:_\s]+/, '');
      const optionOnly = OPTION_LEAD.test(lead) && !/^\d/.test(lead) && d.questionNumber === null;

      return {
        page: d.page,
        draftIndex: d.index,
        score: complete ? 1 : optionOnly ? 0 : 0.6,
        complete,
        completeAtY,
        route: optionOnly ? 'REVIEW' : 'PASS',
        evidence: { complete, cls, optionOnly },
      };
    });
  }
}
