/* eslint-disable no-console */
/**
 * READ-ONLY investigation for AD 2601 missing-question analysis (Problem A).
 * Runs the REAL OCR pipeline (engine + segmentVisualDrafts, unchanged, with cross-page
 * carry) and reports, for every question number in [1..EXPECTED]:
 *   - whether it was ever OCR'd as a leading number (trace.ocrNumbers)
 *   - whether it survived marker detection (trace.markerNumbers)
 *   - whether it survived per-column sequence validation (trace.keptNumbers)
 *   - whether it produced a delivered draft (and that draft's completeness)
 * so each MISSING question is attributed to the exact stage where it died.
 *
 *   npx ts-node --transpile-only scripts/diag-ad-missing.ts "C:/Users/hp/Downloads/AD 2601 Q.pdf" [expectedCount]
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

interface DraftRow extends OcrEngineDraft { page: number; preview: string; }

const main = async (): Promise<void> => {
  const file = process.argv[2] ?? 'C:/Users/hp/Downloads/AD 2601 Q.pdf';
  const expected = Number(process.argv[3] ?? 180);
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doReflow = process.argv.includes('--reflow');
  const scaleArg = process.argv.find((a) => a.startsWith('--scale='));
  const scale = scaleArg ? Number(scaleArg.split('=')[1]) : 2;
  console.log(`render scale=${scale} reflow=${doReflow}`);
  const doc = await pdf(fs.readFileSync(file), { scale });
  const raw: Buffer[] = [];
  for await (const p of doc) raw.push(p as Buffer);
  // Production runs the pre-OCR column reflow first (POST /ocr-preprocess), then the
  // unchanged pipeline. Mirror that when --reflow is passed.
  const pages: Buffer[] = [];
  const reflowedPages: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (doReflow) {
      const r = await reflowPage(raw[i]);
      if (r.reflowed) { pages.push(r.reflowed); reflowedPages.push(i + 1); continue; }
    }
    pages.push(raw[i]);
  }
  if (doReflow) console.log(`reflow: ${reflowedPages.length}/${raw.length} pages reflowed → [${reflowedPages.join(',')}]  (NOT reflowed: [${raw.map((_, i) => i + 1).filter((p) => !reflowedPages.includes(p)).join(',')}])`);
  const flat = await buildFlatField(pages);
  const mask = buildWatermarkMask(flat);
  const worker = await createWorker('eng');

  const drafts: DraftRow[] = [];
  const ocrByPage: number[][] = [];     // raw leading numbers OCR'd at a line start
  const markerByPage: number[][] = [];  // survived marker detection
  const keptByPage: number[][] = [];    // survived per-column sequence validation
  const colByPage: number[] = [];
  let carry: any = null;
  const putObject = async (): Promise<void> => undefined;

  for (let i = 0; i < pages.length; i += 1) {
    const clean = await cleanPageImage(pages[i], flat);
    const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
    const { drafts: vd, carryOut, trace } = await segmentVisualDrafts(clean, collectWordBoxes(data), i + 1, {
      putObject, figureKeyPrefix: 'diag', positionOffset: drafts.length,
      displayFlat: flat, displayMask: mask, displaySource: pages[i], carryIn: carry,
    } as any);
    carry = carryOut;
    for (const d of vd as OcrEngineDraft[]) {
      drafts.push({ ...d, page: i + 1, preview: (d.text ?? '').replace(/\s+/g, ' ').slice(0, 70) });
    }
    const t: any = trace ?? {};
    ocrByPage.push((t.ocrNumbers ?? []).map((o: any) => o.num).filter((n: number) => n >= 1 && n <= expected + 20));
    markerByPage.push((t.markerNumbers ?? []).filter((n: number) => n >= 1));
    keptByPage.push((t.keptNumbers ?? []).filter((n: number) => n >= 1));
    colByPage.push(t.columnCount ?? 0);
    console.log(`page ${String(i + 1).padStart(2)}: cols=${t.columnCount ?? '?'} drafts=${vd.length} kept=[${(keptByPage[i] ?? []).join(',')}]`);
  }
  await worker.terminate();

  const flatOcr = new Set<number>(ocrByPage.flat());
  const flatMarker = new Set<number>(markerByPage.flat());
  const flatKept = new Set<number>(keptByPage.flat());
  const delivered = new Map<number, DraftRow[]>();
  for (const d of drafts) {
    const n = d.questionNumber;
    if (typeof n === 'number' && n >= 1) { if (!delivered.has(n)) delivered.set(n, []); delivered.get(n)!.push(d); }
  }

  // Completeness of a delivered draft (MCQ should have 4 options).
  const isComplete = (d: DraftRow): boolean =>
    !d.invalidCrop && !(d as any).needsImageReview && (d.optionCount ?? 0) >= 4;

  const missing: number[] = [];
  const incomplete: number[] = [];
  const reasons: Record<string, number[]> = {
    never_ocrd: [], dropped_at_marker: [], dropped_at_sequence: [], merged_no_region: [],
    delivered_incomplete: [], delivered_invalid: [],
  };
  for (let n = 1; n <= expected; n += 1) {
    const ds = delivered.get(n) ?? [];
    if (ds.length === 0) {
      missing.push(n);
      if (!flatOcr.has(n)) reasons.never_ocrd.push(n);
      else if (!flatMarker.has(n)) reasons.dropped_at_marker.push(n);
      else if (!flatKept.has(n)) reasons.dropped_at_sequence.push(n);
      else reasons.merged_no_region.push(n);
    } else if (!ds.some(isComplete)) {
      incomplete.push(n);
      const d = ds[0];
      if (d.invalidCrop) reasons.delivered_invalid.push(n);
      else reasons.delivered_incomplete.push(n);
    }
  }

  const dups = [...delivered.entries()].filter(([, v]) => v.length > 1).map(([n, v]) => `${n}×${v.length}`);

  console.log('\n' + '═'.repeat(78));
  console.log(`AD MISSING-QUESTION ANALYSIS — ${path.basename(file)}  (expected ${expected})`);
  console.log('═'.repeat(78));
  console.log(`total drafts                : ${drafts.length}`);
  console.log(`unique question numbers     : ${delivered.size}`);
  console.log(`delivered & complete (≥4opt): ${[...delivered.values()].filter((v) => v.some(isComplete)).length}`);
  console.log(`MISSING (no draft at all)   : ${missing.length}  → [${missing.join(',')}]`);
  console.log(`INCOMPLETE (draft, but bad) : ${incomplete.length}  → [${incomplete.join(',')}]`);
  console.log(`duplicate numbers           : ${dups.length ? dups.join(', ') : 'none'}`);

  console.log('\n── MISSING grouped by failure stage ──');
  const label: Record<string, string> = {
    never_ocrd: 'NEVER OCR\'d (number not read at a line start — scan/2-col/watermark)',
    dropped_at_marker: 'dropped at MARKER detection (content-number / option-shape / not-line-start / >ceiling)',
    dropped_at_sequence: 'dropped at SEQUENCE validation (num <= last in its column)',
    merged_no_region: 'survived as marker but produced NO region (merged into neighbour / blank)',
    delivered_invalid: 'delivered but INVALID crop (no stem+<2 opts / degenerate dims)',
    delivered_incomplete: 'delivered but INCOMPLETE (MCQ <4 options / low conf review)',
  };
  for (const k of Object.keys(reasons)) {
    const arr = reasons[k];
    if (arr.length) console.log(`  [${arr.length}] ${label[k]}\n        → ${arr.join(', ')}`);
  }

  console.log('\n── INCOMPLETE / INVALID delivered drafts (detail) ──');
  for (const n of [...missing, ...incomplete]) {
    for (const d of delivered.get(n) ?? []) {
      console.log(`  Q${n} p${d.page} opts=${d.optionCount ?? 0} cls=${d.questionClass} conf=${(d.confidence ?? 0).toFixed(2)} ` +
        `col=${d.sourceColumn ?? '?'}/${d.sourceColumnCount ?? 1} ${d.invalidCrop ? 'INVALID ' : ''}${(d as any).needsImageReview ? 'review ' : ''}| "${d.preview}"`);
    }
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
