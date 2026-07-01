/* eslint-disable no-console */
/**
 * READ-ONLY layout audit: runs the CURRENT OCR pipeline (engine + segmentVisualDrafts,
 * unchanged) on reference PDFs and reports which questions come out INCOMPLETE — the
 * evidence for whether a column/reflow preprocessing layer is actually needed and where.
 * No pipeline files are modified; this only calls them, like the other diag scripts.
 *
 * Flags a draft as suspect when: invalidCrop, optionCount < 4 (NEET MCQ should have 4 —
 * a cross-column split that loses the options shows up here), or needsImageReview.
 *
 *   npx ts-node scripts/diag-layout-audit.ts "<pdf1>" "<pdf2>" ...
 */
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import * as path from 'path';
import { buildFlatField, buildWatermarkMask, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { segmentVisualDrafts } from '../src/shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../src/shared/ocr-engine/column-reorder';
import type { OcrEngineDraft } from '../src/shared/ocr-engine/ocr-engine';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

const collectWordBoxes = (data: any): OcrWordBox[] => {
  const out: OcrWordBox[] = [];
  for (const b of data?.blocks ?? [])
    for (const p of b.paragraphs ?? [])
      for (const l of p.lines ?? [])
        for (const w of l.words ?? []) {
          const t = (w.text ?? '').trim();
          if (!t || !w.bbox) continue;
          const { x0, y0, x1, y1 } = w.bbox;
          if ([x0, y0, x1, y1].some((v) => typeof v !== 'number')) continue;
          out.push({ text: t, x0, y0, x1, y1 });
        }
  return out;
};

const auditOne = async (file: string, outDir: string): Promise<void> => {
  const bytes = fs.readFileSync(file);
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(bytes, { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);
  const meta0 = await sharp(pages[0]).metadata();
  const pageW = meta0.width ?? 0;
  const flat = await buildFlatField(pages);
  const mask = buildWatermarkMask(flat);

  const worker = await createWorker('eng');
  const drafts: OcrEngineDraft[] = [];
  const crops: Buffer[] = [];
  const putObject = async (_k: string, body: Buffer): Promise<void> => { crops.push(body); };
  for (let i = 0; i < pages.length; i += 1) {
    const clean = await cleanPageImage(pages[i], flat);
    const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
    const { drafts: vd } = await segmentVisualDrafts(clean, collectWordBoxes(data), i + 1, {
      putObject, figureKeyPrefix: 'diag', positionOffset: drafts.length,
      displayFlat: flat, displayMask: mask, displaySource: pages[i],
    } as any);
    drafts.push(...vd);
  }
  await worker.terminate();

  const base = path.basename(file).replace(/\W+/g, '_');
  let suspects = 0;
  let multiCol = 0;
  const rows: string[] = [];
  for (let i = 0; i < drafts.length; i += 1) {
    const d = drafts[i];
    const c = d.sourceCoordinates;
    const cw = c ? c.x1 - c.x0 : 0;
    const widthPct = pageW ? Math.round((cw / pageW) * 100) : 0;
    if ((d.sourceColumnCount ?? 1) > 1) multiCol += 1;
    const fewOpts = (d.optionCount ?? 0) < 4;
    const suspect = d.invalidCrop || fewOpts || d.needsImageReview;
    if (suspect) {
      suspects += 1;
      rows.push(
        `   Q${d.questionNumber ?? '∅'}  opts=${d.optionCount ?? 0}  conf=${(d.confidence ?? 0).toFixed(2)}  ` +
          `w=${widthPct}%page  col=${d.sourceColumn ?? '?'}/${d.sourceColumnCount ?? 1}  ` +
          `${d.invalidCrop ? 'INVALID ' : ''}${fewOpts ? '<4opts ' : ''}${d.needsImageReview ? 'review' : ''}`,
      );
      // save the suspect crop for visual confirmation
      const crop = crops[i];
      if (crop) await sharp(crop).png().toFile(path.join(outDir, `${base}-Q${d.questionNumber ?? 'x'}-p${d.position}.png`));
    }
  }
  console.log(`\n==== ${path.basename(file)} ====`);
  console.log(`pages=${pages.length} pageW=${pageW} detected=${drafts.length} multiColumnCrops=${multiCol} SUSPECT=${suspects}`);
  if (rows.length) console.log(rows.slice(0, 30).join('\n'));
  else console.log('   (no incomplete-crop suspects)');
};

const main = async (): Promise<void> => {
  const files = process.argv.slice(2);
  if (files.length === 0) throw new Error('usage: diag-layout-audit.ts <pdf>...');
  const outDir = 'C:/Users/hp/Downloads/_layout-audit';
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of files) {
    try {
      await auditOne(f, outDir);
    } catch (e) {
      console.log(`\n==== ${path.basename(f)} ==== ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\nsuspect crops → ${outDir}`);
};

main().catch((e) => { console.error(e); process.exit(1); });
