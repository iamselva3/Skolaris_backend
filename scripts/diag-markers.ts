/* eslint-disable no-console */
/**
 * READ-ONLY marker-conflict inventory + proposed-rule safety check.
 * For each reference PDF: run the engine's accepted question markers
 * (findQuestionMarkers), map each back to its SOURCE OCR token, classify the token
 * pattern, and test the two PROPOSED pattern-guards:
 *   LOCANT  : ^\d{1,3}[,\-]\d            ("2,3"  "3,4"  "0,4"  "3-4")
 *   UNIT/VAL: ^\d{1,3}[A-Za-z]{1,3}\b    number fused to a SHORT (≤3) letter run ("70S","10and","5mL")
 *             — distinct from a number glued to a real word ("150Match"), which stays a marker.
 * Reports, per PDF, every marker the guards WOULD reject (page + token + line snippet) and the
 * total accepted-marker count, so we can confirm the guards remove ONLY false markers and never
 * a real question number (180/180 safety). Modifies nothing; pattern-based, no literal values.
 *
 *   npx ts-node scripts/diag-markers.ts "<pdf>" ["<pdf>" ...]
 */
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import * as path from 'path';
import { buildFlatField, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { detectQuestionPunct, findQuestionMarkers, medianHeight } from '../src/shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../src/shared/ocr-engine/column-reorder';

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
const strip = (s: string): string => s.replace(/^["'`|.,;:_\-—\s]+/, '');

// PROPOSED pattern-guards (no literal values).
const LOCANT = /^\d{1,3}[,\-]\d/;                 // a number immediately followed by , or - then a digit
const SHORT_GLUED = /^\d{1,3}[A-Za-z]{1,3}(?![A-Za-z])/; // number fused to a 1–3 letter run (unit / value)
const wouldReject = (rawTok: string): string | null => {
  // operate on the ORIGINAL token (locant/unit live in the raw OCR token)
  if (LOCANT.test(rawTok)) return 'LOCANT (chemistry 2,3 / 3,4,4)';
  if (SHORT_GLUED.test(rawTok)) return 'UNIT / OPTION-VALUE (70S / 10and / 5mL)';
  return null;
};

const main = async (): Promise<void> => {
  for (const file of process.argv.slice(2)) {
    const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
    const doc = await pdf(fs.readFileSync(file), { scale: 2 });
    const pages: Buffer[] = [];
    for await (const p of doc) pages.push(p as Buffer);
    const flat = await buildFlatField(pages);
    const worker = await createWorker('eng');

    console.log(`\n================ ${path.basename(file)} ================`);
    let accepted = 0;
    let rejected = 0;
    const patternCounts: Record<string, number> = {};

    for (let i = 0; i < pages.length; i += 1) {
      const W = (await sharp(pages[i]).metadata()).width ?? 0;
      const clean = await cleanPageImage(pages[i], flat);
      const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
      const words = collectWordBoxes(data);
      const mH = medianHeight(words);
      const qPunct = detectQuestionPunct(words, mH);
      const markers = findQuestionMarkers(words, mH, qPunct);
      accepted += markers.length;

      for (const m of markers) {
        const src = words.find((w) => w.x0 === m.x0 && w.y0 === m.y0);
        const tok = src?.text ?? '';
        const verdict = wouldReject(tok) ?? wouldReject(strip(tok));
        if (verdict) {
          rejected += 1;
          patternCounts[verdict] = (patternCounts[verdict] ?? 0) + 1;
          const cy = src ? (src.y0 + src.y1) / 2 : 0;
          const line = words.filter((w) => Math.abs((w.y0 + w.y1) / 2 - cy) < mH * 0.6)
            .sort((a, b) => a.x0 - b.x0).map((w) => w.text).join(' ').slice(0, 64);
          console.log(`  p${i + 1} REJECT num=${m.num} tok="${tok}" [${verdict}] | "${line}"`);
        }
      }
    }
    await worker.terminate();
    console.log(`  ── accepted markers=${accepted}  proposed-REJECT=${rejected}  (kept=${accepted - rejected})`);
    for (const [k, v] of Object.entries(patternCounts)) console.log(`     ${v}×  ${k}`);
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
