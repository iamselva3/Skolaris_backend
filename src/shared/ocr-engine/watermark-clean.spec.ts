import sharp from 'sharp';
import { buildFlatField, buildWatermarkMask, cleanPageImage } from './watermark-clean';
import type { FlatField } from './watermark-clean';

const pngFromRaw = (pixels: number[], width: number, height: number): Promise<Buffer> =>
  sharp(Buffer.from(pixels), { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();

const rawOf = async (png: Buffer): Promise<Buffer> =>
  (await sharp(png).raw().toBuffer({ resolveWithObject: true })).data;

describe('cleanPageImage (watermark removal)', () => {
  it('whitens light watermark pixels but keeps dark text pixels', async () => {
    // pixel0 = dark text (20), pixel1 = light watermark (215)
    const png = await pngFromRaw([20, 20, 20, 215, 215, 215], 2, 1);
    const out = await rawOf(await cleanPageImage(png));
    expect(out[0]).toBeLessThan(60); // dark text preserved
    expect(out[3]).toBe(255); // light watermark whitened
  });

  it('keeps a coloured (dark) diagram pixel — content protection', async () => {
    // A saturated red line (luma ≈ 76) must survive; a pale grey (luma ≈ 220) must not.
    const png = await pngFromRaw([200, 10, 10, 220, 220, 220], 2, 1);
    const out = await rawOf(await cleanPageImage(png));
    expect(out[0]).toBeGreaterThan(120); // red channel of the dark-luma line kept
    expect(out[3]).toBe(255); // pale grey whitened
  });

  it('removes a DARK repeated watermark via the cross-page flat field', async () => {
    // pixel0 = dark watermark (100) on EVERY page; pixel1 = content (white on
    // pages A/B, dark 30 on page C). The watermark has the same darkness as text
    // — only the cross-page signal separates them.
    const pageA = await pngFromRaw([100, 100, 100, 255, 255, 255], 2, 1);
    const pageB = await pngFromRaw([100, 100, 100, 255, 255, 255], 2, 1);
    const pageC = await pngFromRaw([100, 100, 100, 30, 30, 30], 2, 1);
    const flat = await buildFlatField([pageA, pageB, pageC]);
    expect(flat).not.toBeNull();

    const cleaned = await rawOf(await cleanPageImage(pageC, flat));
    expect(cleaned[0]).toBeGreaterThan(245); // dark watermark removed → ~white
    expect(cleaned[3]).toBeLessThan(80); // real content preserved (still dark)
  });

  it('buildFlatField needs >=3 pages by default (null for too few)', async () => {
    const p = await pngFromRaw([100, 100, 100, 255, 255, 255], 2, 1);
    expect(await buildFlatField([p, p])).toBeNull(); // default min is 3 (protects OCR splitting)
  });

  it('returns the image unchanged when disabled', async () => {
    process.env.OCR_WATERMARK_REMOVAL = 'false';
    const png = await pngFromRaw([215, 215, 215, 215, 215, 215], 2, 1);
    const out = await cleanPageImage(png);
    expect(out).toBe(png); // same buffer reference — no processing
    delete process.env.OCR_WATERMARK_REMOVAL;
  });
});

describe('buildWatermarkMask (large-watermark-only, page-level)', () => {
  // Build a flat field: white (255 = content-capable) everywhere, with grey (180 =
  // persistent watermark) rectangles painted in.
  const W = 200;
  const H = 200;
  const makeFlat = (rects: Array<{ x: number; y: number; w: number; h: number }>): FlatField => {
    const data = new Uint8Array(W * H).fill(255);
    for (const r of rects)
      for (let y = r.y; y < r.y + r.h; y += 1)
        for (let x = r.x; x < r.x + r.w; x += 1) data[y * W + x] = 180;
    return { width: W, height: H, data };
  };
  const at = (m: { width: number; data: Uint8Array }, x: number, y: number): number =>
    m.data[y * m.width + x];

  it('returns null without a flat field (no cross-page consensus)', () => {
    expect(buildWatermarkMask(null)).toBeNull();
  });

  it('MASKS a large persistent grey blob (logo / central stamp)', () => {
    const mask = buildWatermarkMask(makeFlat([{ x: 70, y: 70, w: 60, h: 60 }]))!;
    expect(at(mask, 100, 100)).toBe(255); // centre of the big blob → removal candidate
  });

  it('emits a 0/255 mask (the display gate resamples + tests `< 128`)', () => {
    // Guards against the gate-no-op bug: a 0/1 mask reads as "outside" everywhere.
    const mask = buildWatermarkMask(makeFlat([{ x: 70, y: 70, w: 60, h: 60 }]))!;
    const distinct = new Set(mask.data);
    expect([...distinct].sort((a, b) => a - b)).toEqual([0, 255]);
  });

  it('EXCLUDES a small persistent grey blob (page code like CC-315)', () => {
    const mask = buildWatermarkMask(makeFlat([{ x: 20, y: 20, w: 5, h: 5 }]))!;
    expect(at(mask, 22, 22)).toBe(0); // too small to be a watermark → protected
  });

  it('EXCLUDES a short thin grey line (diagram stroke / table rule)', () => {
    const mask = buildWatermarkMask(makeFlat([{ x: 40, y: 100, w: 20, h: 1 }]))!;
    expect(at(mask, 50, 100)).toBe(0); // thin + short → never whitened
  });

  it('keeps large blobs while still excluding small ones in the same page', () => {
    const mask = buildWatermarkMask(
      makeFlat([
        { x: 70, y: 70, w: 60, h: 60 }, // large watermark
        { x: 10, y: 10, w: 4, h: 4 }, // tiny code
      ]),
    )!;
    expect(at(mask, 100, 100)).toBe(255);
    expect(at(mask, 11, 11)).toBe(0);
  });

  it('is empty when the page has no persistent grey (all content-capable)', () => {
    const mask = buildWatermarkMask(makeFlat([]))!;
    expect(mask.data.some((v) => v !== 0)).toBe(false);
  });
});

describe('OCR_DISPLAY_WM_MASK_CLOSE (seal dark-core holes in the mask)', () => {
  // A large grey watermark blob (accepted) with a DARK core hole in the middle — the
  // core is below GREY_FLOOR so it is not a candidate, leaving a hole through the
  // mask that keeps the stroke core alive. A close fills the hole; it does NOT grow
  // the outer boundary and cannot resurrect rejected components.
  const W = 200;
  const H = 200;
  const makeHoledFlat = (): Uint8Array => {
    const data = new Uint8Array(W * H).fill(255);
    // 60×60 grey (180) square at [70,130) — large ⇒ accepted.
    for (let y = 70; y < 130; y += 1) for (let x = 70; x < 130; x += 1) data[y * W + x] = 180;
    // 16×16 DARK core hole (50 < GREY_FLOOR) at the centre ⇒ not a candidate.
    for (let y = 92; y < 108; y += 1) for (let x = 92; x < 108; x += 1) data[y * W + x] = 50;
    return data;
  };
  const at = (m: { width: number; data: Uint8Array }, x: number, y: number): number =>
    m.data[y * m.width + x];

  afterEach(() => {
    delete process.env.OCR_DISPLAY_WM_MASK_CLOSE;
    jest.resetModules();
  });

  it('DEFAULT (close=0): the dark core is a HOLE in the mask', () => {
    jest.resetModules();
    const { buildWatermarkMask: build } = require('./watermark-clean');
    const mask = build({ width: W, height: H, data: makeHoledFlat() });
    expect(at(mask, 100, 100)).toBe(0); // stroke-centre hole → not masked → watermark survives
    expect(at(mask, 75, 75)).toBe(255); // the surrounding blob IS masked
  });

  it('close=10 seals the hole without growing the outer boundary', () => {
    process.env.OCR_DISPLAY_WM_MASK_CLOSE = '10';
    jest.resetModules();
    const { buildWatermarkMask: build } = require('./watermark-clean');
    const mask = build({ width: W, height: H, data: makeHoledFlat() });
    expect(at(mask, 100, 100)).toBe(255); // hole filled → core now removable in display
    expect(at(mask, 75, 75)).toBe(255); // blob still masked
    expect(at(mask, 60, 60)).toBe(0); // OUTSIDE the blob → still not masked (no outward growth)
  });
});
