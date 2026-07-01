/* eslint-disable no-console */
// END-TO-END production page path: cleanPageForDisplay(rawPage, flat, mask) — exactly what the
// engine runs at finalizePage — then verify the column divider is gone on a REAL PDF.
import sharp from 'sharp';
import { cleanPageForDisplay } from '../src/shared/ocr-engine/crop-display-clean';
import { buildFlatField, buildWatermarkMask } from '../src/shared/ocr-engine/watermark-clean';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

const dividerCol = async (label: string, buf: Buffer) => {
  const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width!;
  const H = info.height!;
  const lo = Math.round(W * 0.3);
  const hi = Math.round(W * 0.7);
  let bx = -1;
  let best = 0;
  for (let x = lo; x < hi; x += 1) {
    let run = 0;
    let b = 0;
    for (let y = 0; y < H; y += 1) { if (data[y * W + x] < 160) { run += 1; if (run > b) b = run; } else run = 0; }
    if (b > best) { best = b; bx = x; }
  }
  console.log(`  [${label}] strongest interior vertical line: x=${bx} run=${best} (${((best / H) * 100).toFixed(1)}% of height)`);
  return best / H;
};

const main = async () => {
  const file = process.argv[2];
  const fs = await import('fs');
  const bytes = new Uint8Array(fs.readFileSync(file));
  const { pdf } = await esmImport('pdf-to-img');
  const doc = await pdf(bytes, { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);
  const flat = await buildFlatField(pages);
  const mask = buildWatermarkMask(flat);
  console.log(`pages=${pages.length} flat=${flat ? `${flat.width}x${flat.height}` : 'null'} mask=${mask ? 'yes' : 'no'}`);
  for (let i = 1; i < Math.min(3, pages.length); i += 1) {
    console.log(`\n=== PAGE ${i + 1} (production cleanPageForDisplay) ===`);
    const before = await dividerCol('BEFORE', pages[i]);
    const cleaned = await cleanPageForDisplay(pages[i], flat, mask, null); // words=null: chrome/footer skipped
    const after = await dividerCol('AFTER ', cleaned);
    console.log(before > 0.33 && after < 0.2 ? '  ✅ divider removed' : after >= 0.33 ? '  ❌ divider REMAINS' : '  (no strong divider before)');
  }
};
main().catch((e) => { console.error(e); process.exit(1); });
