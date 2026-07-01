/* eslint-disable no-console */
/**
 * Validation for the column-reflow preprocess layer.
 *  - NO-OP papers (RE NEET PST, Biology, …): assert reflowPage returns null on EVERY
 *    page ⇒ they go through the unchanged pipeline byte-identical.
 *  - AD 2601 Q: run the CURRENT pipeline on ORIGINAL vs REFLOWED pages and compare the
 *    cropSuspicionScore count (NOT optionCount alone — width<50% AND <4 opts, or
 *    invalidCrop, or needs-review). Incomplete crops should drop; question count should
 *    stay ~same. Read-only; only calls the engine, never modifies it.
 *
 *   npx ts-node scripts/diag-reflow-validate.ts <AD.pdf> <noop1.pdf> <noop2.pdf> ...
 */
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import * as path from 'path';
import { buildFlatField, buildWatermarkMask, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { segmentVisualDrafts } from '../src/shared/ocr-engine/visual-segment';
import { reflowPage } from '../src/modules/ocr-preprocess/column-reflow';
import type { OcrWordBox } from '../src/shared/ocr-engine/column-reorder';
import type { OcrEngineDraft } from '../src/shared/ocr-engine/ocr-engine';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
const collectWordBoxes = (d: any): OcrWordBox[] => {
  const out: OcrWordBox[] = [];
  for (const b of d?.blocks ?? []) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) for (const w of l.words ?? []) {
    const t = (w.text ?? '').trim(); if (!t || !w.bbox) continue;
    const { x0, y0, x1, y1 } = w.bbox; if ([x0, y0, x1, y1].some((v) => typeof v !== 'number')) continue;
    out.push({ text: t, x0, y0, x1, y1 });
  }
  return out;
};
const renderPdf = async (file: string): Promise<Buffer[]> => {
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(fs.readFileSync(file), { scale: 2 });
  const pages: Buffer[] = []; for await (const p of doc) pages.push(p as Buffer); return pages;
};

// cropSuspicionScore — incomplete crop, NOT a 2×2-grid miscount.
const isSuspect = (d: OcrEngineDraft, pageW: number): boolean => {
  const c = d.sourceCoordinates;
  const widthPct = c && pageW ? ((c.x1 - c.x0) / pageW) * 100 : 100;
  const narrowFewOpts = widthPct < 50 && (d.optionCount ?? 0) < 4; // cross-column loss
  return Boolean(d.invalidCrop) || narrowFewOpts || Boolean(d.needsImageReview);
};

const auditPages = async (pages: Buffer[]): Promise<{ total: number; suspects: number }> => {
  const flat = await buildFlatField(pages);
  const mask = buildWatermarkMask(flat);
  const worker = await createWorker('eng');
  const drafts: OcrEngineDraft[] = [];
  const widths: number[] = [];
  const putObject = async (): Promise<void> => undefined;
  for (let i = 0; i < pages.length; i += 1) {
    const meta = await sharp(pages[i]).metadata();
    const clean = await cleanPageImage(pages[i], flat);
    const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
    const { drafts: vd } = await segmentVisualDrafts(clean, collectWordBoxes(data), i + 1, {
      putObject, figureKeyPrefix: 'diag', positionOffset: drafts.length, displayFlat: flat, displayMask: mask, displaySource: pages[i],
    } as any);
    for (const _ of vd) widths.push(meta.width ?? 0);
    drafts.push(...vd);
  }
  await worker.terminate();
  let suspects = 0;
  for (let i = 0; i < drafts.length; i += 1) if (isSuspect(drafts[i], widths[i])) suspects += 1;
  return { total: drafts.length, suspects };
};

const main = async (): Promise<void> => {
  const [ad, ...noop] = process.argv.slice(2);

  console.log('=== NO-OP SAFETY (must reflow 0 pages ⇒ identical) ===');
  for (const f of noop) {
    const pages = await renderPdf(f);
    let reflowed = 0;
    for (const p of pages) { const r = await reflowPage(p); if (r.reflowed) reflowed += 1; }
    console.log(`  ${path.basename(f)}: reflowed ${reflowed}/${pages.length}  ${reflowed === 0 ? 'IDENTICAL ✅' : '*** CHANGED ***'}`);
  }

  console.log(`\n=== AD 2601 Q — original vs reflowed (incomplete crops should drop) ===`);
  const pages = await renderPdf(ad);
  let reflowedCount = 0;
  const reflowedPages: Buffer[] = [];
  for (const p of pages) { const r = await reflowPage(p); if (r.reflowed) { reflowedCount += 1; reflowedPages.push(r.reflowed); } else reflowedPages.push(p); }
  console.log(`  pages reflowed: ${reflowedCount}/${pages.length}`);
  process.stdout.write('  auditing ORIGINAL…\n');
  const before = await auditPages(pages);
  process.stdout.write('  auditing REFLOWED…\n');
  const after = await auditPages(reflowedPages);
  console.log(`  ORIGINAL : ${before.total} questions, ${before.suspects} incomplete-crop suspects`);
  console.log(`  REFLOWED : ${after.total} questions, ${after.suspects} incomplete-crop suspects`);
  console.log(`  → suspects ${before.suspects} → ${after.suspects}  (${before.suspects - after.suspects >= 0 ? 'reduced by ' + (before.suspects - after.suspects) : 'INCREASED'}), question count ${before.total}→${after.total}`);
};

main().catch((e) => { console.error(e); process.exit(1); });
