/* eslint-disable no-console */
/**
 * READ-ONLY OCR audit — REBUILT (2026-06-16). Gates do NOT use optionCount, hasStem, or
 * contiguous numbering. A duplicate is judged by comparing each instance against its
 * well-formed sibling (text + crop), so legitimate section restarts are NOT failures.
 *
 * Per draft signals (all coordinate/text based, never optionCount/hasStem):
 *   - ORPHAN        : text starts with an option label (A/B/C/D / (1)) and has NO question number.
 *   - COORD-ISSUE   : missing / inverted / out-of-bounds / sub-8px crop geometry.
 * Per duplicate number group, each instance is classified:
 *   - well-formed   : ≥25 alpha chars AND starts with its own "<n>." / "<n>)" AND not a content-number.
 *   - marker-conflict : starts with a content number (locant / unit / sign-prefixed unit).
 *   - ocr-mislabel  : the first real "<m>." in the crop differs from the labeled number n.
 *   - real-fragment : degenerate stub (short / not well-formed, not the above).
 * A group whose instances are ALL well-formed → SECTION-RESTART / legitimate duplicate (OK).
 * A group with any non-well-formed instance → those instances are REAL FRAGMENTS (failures).
 *
 * Pass gates: real fragments == 0 AND orphans == 0 AND coord issues == 0.
 * Derived actual = OCR count − real fragments − orphans − coord issues (section restarts kept).
 *
 *   npx ts-node scripts/diag-audit.ts "<pdf>" ["<pdf>" ...]
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

const lead = (s: string): string => (s ?? '').replace(/^["'`|.,;:_\s]+/, '');
const alphaCount = (s: string): number => (s.match(/[A-Za-z]/g) ?? []).length;
const OPTION_START = /^\(?([A-Da-d])[.)]|^\(([1-4])\)/;
const CONTENT_NUM_START = /^[-—–]?\d{1,3}(?:[,\-]\d|[A-Za-z]{1,3}(?![A-Za-z]))/; // 2,3 / -22Gm / 85eV / 70S
const firstCleanQNum = (s: string): number | null => { const m = s.match(/(\d{1,3})\.(?=\s|[A-Z])/); return m ? +m[1] : null; };
// The labeled number appears (within leading OCR noise) as its own token with a question
// terminator. Tolerates a stray noise word/char before it ("[. Co 17." / ". q 24.") and
// accepts , ; : terminators (OCR misreads "." as those — the engine treats them as markers).
const startsWithLabeled = (s: string, n: number): boolean => {
  const m = lead(s).match(new RegExp('(?<![0-9])0*' + n + '[.):;,]'));
  return !!m && (m.index ?? 99) <= 14;
};
const isWellFormed = (text: string, n: number): boolean => {
  if (alphaCount(text) < 25 || !startsWithLabeled(text, n) || CONTENT_NUM_START.test(lead(text))) return false;
  const fq = firstCleanQNum(text); // a DIFFERENT clean "<m>." early ⇒ this crop is a mislabel of m, not n
  return fq === null || fq === n;
};
const classifyBad = (text: string, n: number): 'marker-conflict' | 'ocr-mislabel' | 'real-fragment' => {
  if (CONTENT_NUM_START.test(lead(text))) return 'marker-conflict';
  const fq = firstCleanQNum(text);
  if (fq !== null && fq !== n) return 'ocr-mislabel';
  return 'real-fragment';
};

interface D { page: number; qnum: number | null | undefined; text: string; coordsOk: boolean; orphan: boolean; }

const auditPdf = async (file: string): Promise<void> => {
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(fs.readFileSync(file), { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);
  const flat = await buildFlatField(pages);
  const mask = buildWatermarkMask(flat);
  const worker = await createWorker('eng');
  const drafts: D[] = [];
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
      const c = d.sourceCoordinates;
      const coordsOk = !!c && c.x1 > c.x0 && c.y1 > c.y0 && c.x0 >= 0 && c.y0 >= 0 && c.x1 <= W && c.y1 <= H && c.x1 - c.x0 >= 8 && c.y1 - c.y0 >= 8;
      const t = (d.text ?? '').replace(/\s+/g, ' ').trim();
      drafts.push({ page: i + 1, qnum: d.questionNumber, text: t, coordsOk, orphan: OPTION_START.test(lead(t)) && !/^\d/.test(lead(t)) });
    }
  }
  await worker.terminate();

  const orphans = drafts.filter((d) => d.orphan);
  const coordIssues = drafts.filter((d) => !d.coordsOk);

  // group by question number
  const groups = new Map<number, D[]>();
  for (const d of drafts) if (typeof d.qnum === 'number' && d.qnum > 0) { if (!groups.has(d.qnum)) groups.set(d.qnum, []); groups.get(d.qnum)!.push(d); }

  const fragments: Array<{ n: number; page: number; label: string }> = [];
  const legit: Array<{ n: number; k: number }> = [];
  for (const [n, insts] of groups) {
    if (insts.length < 2) continue;
    const bad = insts.filter((d) => !isWellFormed(d.text, n));
    if (bad.length === 0) { legit.push({ n, k: insts.length }); continue; }
    for (const d of bad) fragments.push({ n, page: d.page, label: classifyBad(d.text, n) });
  }

  const ocrCount = drafts.length;
  const realFragments = fragments.length;
  const actual = ocrCount - realFragments - orphans.length - coordIssues.length;
  const pass = realFragments === 0 && orphans.length === 0 && coordIssues.length === 0;

  console.log(`\n================ ${path.basename(file)} ================`);
  console.log(`  OCR count            : ${ocrCount}`);
  console.log(`  Actual count (derived): ${actual}   [= OCR − fragments − orphans − coord-issues; section restarts kept]`);
  console.log(`  Real fragments       : ${realFragments}`);
  for (const f of fragments) console.log(`       Q${f.n} p${f.page} — ${f.label}`);
  console.log(`  Legitimate duplicates: ${legit.length} group(s)${legit.length ? '  → ' + legit.map((g) => `Q${g.n}×${g.k}`).join(', ') : ''}  [section-restart / legitimate]`);
  console.log(`  Orphans              : ${orphans.length}${orphans.length ? '  → ' + orphans.slice(0, 10).map((d) => `Q${d.qnum ?? '∅'} p${d.page}`).join(', ') : ''}`);
  console.log(`  Coordinate issues    : ${coordIssues.length}${coordIssues.length ? '  → ' + coordIssues.slice(0, 10).map((d) => `Q${d.qnum ?? '∅'} p${d.page}`).join(', ') : ''}`);
  console.log(`  GATES (no fragments / no orphans / no coord issues) ⇒ ${pass ? 'PASS ✅ (not declared fixed)' : 'FAIL ❌'}`);
};

const main = async (): Promise<void> => {
  for (const f of process.argv.slice(2)) {
    try { await auditPdf(f); } catch (e) { console.log(`\n==== ${path.basename(f)} ERROR: ${e instanceof Error ? e.message : String(e)}`); }
  }
};
main().catch((e) => { console.error(e); process.exit(1); });
