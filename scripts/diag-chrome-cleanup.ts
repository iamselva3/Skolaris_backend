/* eslint-disable no-console */
/**
 * SAFETY PROOF for the optional page-chrome cleanup (no OCR). Builds the document profile, sanitizes
 * each page, and PROVES content was never touched:
 *   (1) every pixel that DIFFERS from the original is either a REPEATED-CHROME mask pixel (inked on
 *       ≥ REPEAT_FRAC of pages, inside the top/bottom margin strip) OR inside a thin border/divider line,
 *   (2) every border/divider rect is a thin line at an edge / the central band,
 *   (3) content pages (no repeated chrome, no frame) are strict NO-OPs.
 * Saves before/after for the first changed page of each PDF.
 *
 *   npx ts-node scripts/diag-chrome-cleanup.ts "<pdf>" ["<pdf>" ...]
 */
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import { buildChromeProfile, sanitizePage, ChromeRect } from '../src/modules/ocr-preprocess/page-chrome-cleanup';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
const BORDER_ZONE = Number(process.env.PRE_CHROME_BORDER_ZONE ?? 0.04);
const DIVIDER_LO = Number(process.env.PRE_CHROME_DIVIDER_LO ?? 0.3);
const DIVIDER_HI = Number(process.env.PRE_CHROME_DIVIDER_HI ?? 0.7);
const LINE_MAX_THICK = Number(process.env.PRE_CHROME_LINE_THICK ?? 0.006);

const isValidLine = (r: ChromeRect, W: number, H: number): boolean => {
  const thinH = Math.max(1, Math.round(H * LINE_MAX_THICK)) + 1;
  const thinW = Math.max(1, Math.round(W * LINE_MAX_THICK)) + 1;
  if (r.kind === 'border-top') return r.h <= thinH && r.y + r.h <= Math.round(H * BORDER_ZONE) + 1;
  if (r.kind === 'border-bottom') return r.h <= thinH && r.y >= Math.round(H * (1 - BORDER_ZONE)) - 1;
  if (r.kind === 'border-left') return r.w <= thinW && r.x + r.w <= Math.round(W * BORDER_ZONE) + 1;
  if (r.kind === 'border-right') return r.w <= thinW && r.x >= Math.round(W * (1 - BORDER_ZONE)) - 1;
  if (r.kind === 'column-divider') return r.w <= thinW && r.x >= Math.round(W * DIVIDER_LO) - 1 && r.x + r.w <= Math.round(W * DIVIDER_HI) + 1;
  return false;
};
const inLineRects = (x: number, y: number, rects: ChromeRect[]): boolean =>
  rects.some((r) => r.kind.startsWith('border') || r.kind === 'column-divider' ? x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h : false);

const main = async (): Promise<void> => {
  const out = 'C:/Users/hp/Downloads/_chrome'; fs.mkdirSync(out, { recursive: true });
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  let gViol = 0; let gBad = 0;
  for (const file of process.argv.slice(2)) {
    const base = path.basename(file).replace(/\W+/g, '_');
    const doc = await pdf(fs.readFileSync(file), { scale: 2 });
    const pages: Buffer[] = []; for await (const p of doc) pages.push(p as Buffer);
    const profile = await buildChromeProfile(pages);
    const { W, H, stripH, topMask, botMask } = profile;
    let changed = 0; let viol = 0; let bad = 0; const kinds = new Map<string, number>(); let saved = false;
    for (let i = 0; i < pages.length; i += 1) {
      const res = await sanitizePage(pages[i], profile);
      for (const r of res.removed) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
      if (!res.changed) continue;
      changed += 1;
      const lineRects = res.removed.filter((r) => r.kind.startsWith('border') || r.kind === 'column-divider');
      for (const r of lineRects) if (!isValidLine(r, W, H)) bad += 1;
      const a = await sharp(pages[i]).greyscale().raw().toBuffer({ resolveWithObject: true });
      const b = await sharp(res.image).greyscale().raw().toBuffer({ resolveWithObject: true });
      for (let y = 0; y < H; y += 1) {
        const row = y * W;
        for (let x = 0; x < W; x += 1) {
          if (a.data[row + x] === b.data[row + x]) continue;
          const inTop = y < stripH && topMask && topMask[y * W + x] === 1;
          const inBot = y >= H - stripH && botMask && botMask[(y - (H - stripH)) * W + x] === 1;
          if (inTop || inBot || inLineRects(x, y, lineRects)) continue;
          viol += 1; // a changed pixel that is NOT repeated-chrome and NOT a line ⇒ content touch
        }
      }
      if (!saved) { await sharp(pages[i]).png().toFile(path.join(out, `${base}-p${i + 1}-BEFORE.png`)); await sharp(res.image).png().toFile(path.join(out, `${base}-p${i + 1}-AFTER.png`)); saved = true; }
    }
    gViol += viol; gBad += bad;
    const kstr = [...kinds.entries()].map(([k, n]) => `${k}:${n}`).join(' ') || '—';
    const mk = `topMaskInk=${profile.topMaskInk} botMaskInk=${profile.botMaskInk}`;
    console.log(`\n==== ${path.basename(file)} :: pages=${pages.length} changed=${changed} removed[${kstr}]  (${mk})`);
    console.log(`     SAFETY → content-pixel violations=${viol}  non-thin-line rects=${bad}`);
  }
  console.log(`\n================ CHROME CLEANUP SAFETY ================`);
  console.log(`  content-pixel violations: ${gViol} (MUST be 0 — only repeated chrome + thin lines change)`);
  console.log(`  non-thin-line rects:      ${gBad} (MUST be 0)`);
  console.log(`  RESULT: ${gViol === 0 && gBad === 0 ? 'CONTENT-SAFE ✅' : 'UNSAFE ❌'}`);
  console.log(`  before/after → ${out}`);
};
main().catch((e) => { console.error(e); process.exit(1); });
