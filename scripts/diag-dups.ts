/* eslint-disable no-console */
/**
 * READ-ONLY duplicate-question verification. Runs the real segmentVisualDrafts, finds every
 * question NUMBER that appears in >1 draft, and for EACH instance reports
 *   PDF · Q# · source page · crop coordinates · width% · optionCount · text snippet
 * and SAVES the crop image (extracted from the source page by sourceCoordinates) so the
 * duplicate can be classified by comparing crop image + source page + text — never by number
 * alone. Classify: REAL-FRAGMENT / RE-NUMBERING / MARKER-CONFLICT / SECTION-RESTART / MISLABEL.
 *
 *   npx ts-node scripts/diag-dups.ts "<pdf>" ["<pdf>" ...]
 *   crops → C:/Users/hp/Downloads/_dups/<base>-Q<n>-p<page>-<i>.png
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
const collectWordBoxes = (d: any): OcrWordBox[] => {
  const out: OcrWordBox[] = [];
  for (const b of d?.blocks ?? []) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) for (const w of l.words ?? []) {
    const t = (w.text ?? '').trim(); if (!t || !w.bbox) continue;
    const { x0, y0, x1, y1 } = w.bbox; if ([x0, y0, x1, y1].some((v) => typeof v !== 'number')) continue;
    out.push({ text: t, x0, y0, x1, y1 });
  }
  return out;
};

interface Inst { page: number; W: number; H: number; coords?: { x0: number; y0: number; x1: number; y1: number }; opts: number; text: string; buf: Buffer; }

const main = async (): Promise<void> => {
  const outDir = 'C:/Users/hp/Downloads/_dups';
  fs.mkdirSync(outDir, { recursive: true });
  for (const file of process.argv.slice(2)) {
    const base = path.basename(file).replace(/\W+/g, '_');
    const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
    const doc = await pdf(fs.readFileSync(file), { scale: 2 });
    const pages: Buffer[] = [];
    for await (const p of doc) pages.push(p as Buffer);
    const flat = await buildFlatField(pages);
    const mask = buildWatermarkMask(flat);
    const worker = await createWorker('eng');
    const byNum = new Map<number, Inst[]>();
    const putObject = async (): Promise<void> => undefined;
    let total = 0;
    for (let i = 0; i < pages.length; i += 1) {
      const meta = await sharp(pages[i]).metadata();
      const W = meta.width ?? 0, H = meta.height ?? 0;
      const clean = await cleanPageImage(pages[i], flat);
      const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
      const { drafts: vd } = await segmentVisualDrafts(clean, collectWordBoxes(data), i + 1, {
        putObject, figureKeyPrefix: 'diag', positionOffset: total, displayFlat: flat, displayMask: mask, displaySource: pages[i],
      } as any);
      total += vd.length;
      for (const d of vd as OcrEngineDraft[]) {
        const n = d.questionNumber;
        if (typeof n !== 'number' || n <= 0) continue;
        const c = d.sourceCoordinates;
        const buf = c
          ? await sharp(pages[i]).extract({ left: Math.max(0, c.x0), top: Math.max(0, c.y0), width: Math.min(W - c.x0, c.x1 - c.x0), height: Math.min(H - c.y0, c.y1 - c.y0) }).png().toBuffer()
          : Buffer.alloc(0);
        if (!byNum.has(n)) byNum.set(n, []);
        byNum.get(n)!.push({ page: i + 1, W, H, coords: c, opts: d.optionCount ?? 0, text: (d.text ?? '').replace(/\s+/g, ' ').slice(0, 80), buf });
      }
    }
    await worker.terminate();

    const dups = [...byNum.entries()].filter(([, v]) => v.length > 1).sort((a, b) => a[0] - b[0]);
    console.log(`\n================ ${path.basename(file)} ====  duplicate numbers: ${dups.length} ================`);
    for (const [n, insts] of dups) {
      console.log(`  Q${n} ×${insts.length}:`);
      for (let i = 0; i < insts.length; i += 1) {
        const it = insts[i];
        const wPct = it.coords && it.W ? Math.round(((it.coords.x1 - it.coords.x0) / it.W) * 100) : 0;
        const fn = `${base}-Q${n}-p${it.page}-${i}.png`;
        if (it.buf.length) fs.writeFileSync(path.join(outDir, fn), it.buf);
        console.log(`     [${i}] p${it.page} x=[${it.coords?.x0}..${it.coords?.x1}] y=[${it.coords?.y0}..${it.coords?.y1}] w=${wPct}% opts=${it.opts} → ${fn}`);
        console.log(`          "${it.text}"`);
      }
    }
  }
  console.log(`\ncrops → ${outDir}`);
};

main().catch((e) => { console.error(e); process.exit(1); });
