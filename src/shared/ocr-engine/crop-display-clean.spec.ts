import sharp from 'sharp';
import { cleanCropForDisplay } from './crop-display-clean';
import { buildWatermarkMask } from './watermark-clean';
import type { FlatField, WatermarkMask } from './watermark-clean';

const grayRow = (vals: number[]): Promise<Buffer> => {
  const px: number[] = [];
  for (const v of vals) px.push(v, v, v);
  return sharp(Buffer.from(px), { raw: { width: vals.length, height: 1, channels: 3 } })
    .png()
    .toBuffer();
};

const rawOf = async (png: Buffer): Promise<Buffer> =>
  (await sharp(png).raw().toBuffer({ resolveWithObject: true })).data;

const flat = (data: number[]): FlatField => ({
  width: data.length,
  height: 1,
  data: Uint8Array.from(data),
});

describe('cleanCropForDisplay (binary, content-faithful watermark suppression)', () => {
  const reg = (w: number) => ({ x0: 0, y0: 0, x1: w, y1: 1 });
  const clean = (crop: Buffer, fd: number[]) =>
    cleanCropForDisplay(crop, {
      flat: flat(fd),
      region: reg(fd.length),
      pageWidth: fd.length,
      pageHeight: 1,
    });

  it('is BINARY — a kept pixel is byte-identical (no fade / no contrast change)', async () => {
    // A faint chemical-bond pixel (165) darker than its persistent background (205)
    // must be returned EXACTLY, not lightened.
    const out = await rawOf(await clean(await grayRow([165, 165]), [205, 205]));
    expect(out[0]).toBe(165); // unchanged to the byte
    expect(out[3]).toBe(165);
  });

  it('PRESERVES a light diagram stroke unique to this page (flat bright)', async () => {
    const out = await rawOf(await clean(await grayRow([160, 160]), [255, 255]));
    expect(out[0]).toBe(160);
  });

  it('NEVER changes a medium/dark pixel (absolute content floor)', async () => {
    // Even with a grey persistent flat, a pixel below the floor is content → kept.
    const out = await rawOf(await clean(await grayRow([110, 110]), [180, 180]));
    expect(out[0]).toBe(110);
  });

  it('removes a confident watermark pixel FULLY to white (binary, not a fade)', async () => {
    // Light (205), at a persistent grey location (flat 200), no extra darkness → white.
    const out = await rawOf(await clean(await grayRow([205, 205]), [200, 200]));
    expect(out[0]).toBe(255);
    expect(out[3]).toBe(255);
  });

  it('only ever LIGHTENS — never darkens a pixel', async () => {
    const before = [205, 165, 110, 30, 200];
    const flatd = [200, 205, 180, 180, 200];
    const out = await rawOf(await clean(await grayRow(before), flatd));
    for (let p = 0; p < before.length; p += 1) expect(out[p * 3]).toBeGreaterThanOrEqual(before[p]);
  });

  it('returns the crop UNCHANGED when there is no cross-page consensus (no flat field)', async () => {
    const crop = await grayRow([180, 180]);
    expect(await cleanCropForDisplay(crop, {})).toBe(crop);
  });

  it('returns the original buffer when disabled', async () => {
    process.env.OCR_DISPLAY_WATERMARK_CLEANUP = 'false';
    const crop = await grayRow([205, 205]);
    expect(await clean(crop, [200, 200])).toBe(crop);
    delete process.env.OCR_DISPLAY_WATERMARK_CLEANUP;
  });

  describe('page-level large-watermark mask gate', () => {
    const mask = (data: number[]): WatermarkMask => ({
      width: data.length,
      height: 1,
      data: Uint8Array.from(data.map((v) => (v ? 255 : 0))),
    });
    const cleanMasked = (crop: Buffer, fd: number[], mk: number[]) =>
      cleanCropForDisplay(crop, {
        flat: flat(fd),
        mask: mask(mk),
        region: reg(fd.length),
        pageWidth: fd.length,
        pageHeight: 1,
      });

    it('KEEPS a dark thin line / label / code outside the mask (ink halo, all passes on)', async () => {
      // A real thin line / small label / page code is DARK ink → kept by the dark-core
      // guard and the background pass's ink halo, even though it is outside the mask.
      const out = await rawOf(await cleanMasked(await grayRow([100, 100]), [200, 200], [0, 0]));
      expect(out[0]).toBe(100);
      expect(out[3]).toBe(100);
    });

    it('mask gate alone keeps a light would-be-watermark pixel outside the mask (post-passes off)', async () => {
      process.env.OCR_DISPLAY_BG_CLEANUP = 'false';
      process.env.OCR_DISPLAY_DIVIDER_CLEANUP = 'false';
      const out = await rawOf(await cleanMasked(await grayRow([205, 205]), [200, 200], [0, 0]));
      delete process.env.OCR_DISPLAY_BG_CLEANUP;
      delete process.env.OCR_DISPLAY_DIVIDER_CLEANUP;
      expect(out[0]).toBe(205); // pass-1 gate keeps it; background pass removes it (tested below)
    });

    it('still WHITENS a confident watermark pixel that lies INSIDE the mask', async () => {
      const out = await rawOf(await cleanMasked(await grayRow([205, 205]), [200, 200], [1, 1]));
      expect(out[0]).toBe(255);
    });

    it('protects content INSIDE the mask too (mask gates, content guards still apply)', async () => {
      // Inside the large watermark blob, but darker than background (content drawn
      // over the watermark) → still kept verbatim.
      const out = await rawOf(await cleanMasked(await grayRow([165, 165]), [205, 205], [1, 1]));
      expect(out[0]).toBe(165);
    });

    it('REGRESSION: a real buildWatermarkMask mask actually whitens watermark pixels end-to-end', async () => {
      // The gate bug shipped because masks were emitted 0/1 and tested `< 128` →
      // a no-op. This drives the REAL buildWatermarkMask output through
      // cleanCropForDisplay and asserts the watermark is whitened and content kept.
      // Mirrors production: a LOW-res flat field upscaled to a higher-res page.
      const F = 30; // flat resolution
      const P = 60; // page/crop resolution (2× upscale, like 700→1224)
      const fd = new Uint8Array(F * F).fill(255);
      for (let y = 8; y < 22; y += 1) for (let x = 8; x < 22; x += 1) fd[y * F + x] = 200; // big grey blob
      const flatField: FlatField = { width: F, height: F, data: fd };
      const mask = buildWatermarkMask(flatField)!;
      expect(mask.data.some((v) => v === 255)).toBe(true);

      // Crop = the page: white, a watermark-grey block (over the blob), one dark
      // content pixel drawn on top of the watermark.
      const px = new Uint8Array(P * P * 3).fill(255);
      const set = (x: number, y: number, v: number) => {
        const i = (y * P + x) * 3;
        px[i] = v;
        px[i + 1] = v;
        px[i + 2] = v;
      };
      const wm: number[] = [];
      for (let y = 20; y < 40; y += 1)
        for (let x = 20; x < 40; x += 1) {
          set(x, y, 200);
          wm.push(y * P + x);
        }
      set(30, 30, 50); // dark content over the watermark
      const crop = await sharp(Buffer.from(px), { raw: { width: P, height: P, channels: 3 } })
        .png()
        .toBuffer();

      const out = await cleanCropForDisplay(crop, {
        flat: flatField,
        mask,
        region: { x0: 0, y0: 0, x1: P, y1: P },
        pageWidth: P,
        pageHeight: P,
      });
      const g = await sharp(out).greyscale().raw().toBuffer();
      const whitened = wm.filter((i) => g[i] >= 250).length;
      expect(whitened).toBeGreaterThan(wm.length / 2); // most of the watermark block removed
      expect(g[30 * P + 30]).toBeLessThan(120); // dark content over watermark → kept
    });
  });

  describe('background + divider post-passes (conservative, content-safe)', () => {
    // Build a width×height greyscale PNG from a per-pixel function.
    const makeImg = (
      w: number,
      h: number,
      fn: (x: number, y: number) => number,
    ): Promise<Buffer> => {
      const px = new Uint8Array(w * h * 3);
      for (let y = 0; y < h; y += 1)
        for (let x = 0; x < w; x += 1) {
          const v = fn(x, y);
          const i = (y * w + x) * 3;
          px[i] = v;
          px[i + 1] = v;
          px[i + 2] = v;
        }
      return sharp(Buffer.from(px), { raw: { width: w, height: h, channels: 3 } })
        .png()
        .toBuffer();
    };
    const field2 = (w: number, h: number, fn: (x: number, y: number) => number): FlatField => {
      const d = new Uint8Array(w * h);
      for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) d[y * w + x] = fn(x, y);
      return { width: w, height: h, data: d };
    };
    const run = (crop: Buffer, flat: FlatField, w: number, h: number, mk?: WatermarkMask) =>
      cleanCropForDisplay(crop, {
        flat,
        mask: mk,
        region: { x0: 0, y0: 0, x1: w, y1: h },
        pageWidth: w,
        pageHeight: h,
      });
    const gray = (png: Buffer) => sharp(png).greyscale().raw().toBuffer();

    it('PASS 2 removes a faint persistent trail far from any ink', async () => {
      const W = 30,
        H = 30;
      const crop = await makeImg(W, H, () => 205); // uniform faint grey, no ink
      const flat = field2(W, H, () => 200); // persistent (never white)
      const g = await gray(await run(crop, flat, W, H));
      expect(g[15 * W + 15]).toBe(255); // background remnant whitened
    });

    it('PASS 2 keeps faint pixels NEXT TO ink (halo protects text/diagram edges)', async () => {
      const W = 30,
        H = 30;
      // a dark ink dot at centre; faint grey everywhere else
      const crop = await makeImg(W, H, (x, y) => (x === 15 && y === 15 ? 40 : 205));
      const flat = field2(W, H, () => 200);
      const g = await gray(await run(crop, flat, W, H));
      expect(g[15 * W + 16]).toBe(205); // immediately beside ink → within halo → kept
      expect(g[15 * W + 15]).toBeLessThan(120); // the ink itself → kept
    });

    it('PASS 2 keeps faint UNIQUE pixels (flat bright) even far from ink', async () => {
      const W = 30,
        H = 30;
      const crop = await makeImg(W, H, () => 205);
      const flat = field2(W, H, () => 255); // white on some page → unique content-capable
      const g = await gray(await run(crop, flat, W, H));
      expect(g[15 * W + 15]).toBe(205); // kept (could be unique content)
    });

    it('PASS 3 removes a persistent, isolated divider line', async () => {
      const W = 21,
        H = 40;
      const crop = await makeImg(W, H, (x) => (x === 10 ? 70 : 255)); // dark vertical line at x=10
      const flat = field2(W, H, (x) => (x === 10 ? 70 : 255)); // line is persistent across pages
      const g = await gray(await run(crop, flat, W, H));
      expect(g[20 * W + 10]).toBe(255); // isolated persistent divider → removed
    });

    it('PASS 3 keeps a UNIQUE vertical line (flat bright = content, e.g. a graph axis)', async () => {
      const W = 21,
        H = 40;
      const crop = await makeImg(W, H, (x) => (x === 10 ? 70 : 255));
      const flat = field2(W, H, () => 255); // line is unique to this page → content
      const g = await gray(await run(crop, flat, W, H));
      expect(g[20 * W + 10]).toBeLessThan(120); // unique content line → kept
    });

    it('PASS 3 keeps a divider segment that has text beside it', async () => {
      const W = 21,
        H = 40;
      // vertical line at x=10 (persistent) AND a text stroke at x=14 on every row
      const crop = await makeImg(W, H, (x) => (x === 10 || x === 14 ? 70 : 255));
      const flat = field2(W, H, (x) => (x === 10 ? 70 : 255)); // only the divider is persistent
      const g = await gray(await run(crop, flat, W, H));
      expect(g[20 * W + 14]).toBeLessThan(120); // text kept (unique)
      expect(g[20 * W + 10]).toBeLessThan(120); // divider kept HERE — ink within DIV_ISOLATE → not isolated
    });

    // TRAIL mode: clear a self-protecting MEDIUM-grey trail in empty background, while
    // keeping it next to ink and at unique-content (flat-bright) locations. The trail
    // lives OUTSIDE the large mask (Pass 2's domain), so pass an all-0 mask so the
    // main pass skips it and Pass 2 is what acts.
    describe('TRAIL mode (OCR_DISPLAY_BG_TRAIL) — clear empty-bg trail, never content', () => {
      const W = 30;
      const H = 30;
      const noMask = (): WatermarkMask => ({ width: W, height: H, data: new Uint8Array(W * H) });
      afterEach(() => delete process.env.OCR_DISPLAY_BG_TRAIL);

      it('DISABLED (env=false): a medium-grey persistent trail pixel self-protects → KEPT', async () => {
        process.env.OCR_DISPLAY_BG_TRAIL = 'false'; // default is ON; this is the disable path
        const crop = await makeImg(W, H, (x, y) => (x === 15 && y === 15 ? 130 : 255));
        const flat = field2(W, H, () => 135); // persistent grey
        const g = await gray(await run(crop, flat, W, H, noMask()));
        expect(g[15 * W + 15]).toBe(130);
      });

      it('DEFAULT (now ON): the empty-background medium trail pixel is CLEARED (no env set)', async () => {
        const crop = await makeImg(W, H, (x, y) => (x === 15 && y === 15 ? 130 : 255));
        const flat = field2(W, H, () => 135);
        const g = await gray(await run(crop, flat, W, H, noMask()));
        expect(g[15 * W + 15]).toBe(255);
      });

      it('ON: the same empty-background medium trail pixel is CLEARED', async () => {
        process.env.OCR_DISPLAY_BG_TRAIL = 'true';
        const crop = await makeImg(W, H, (x, y) => (x === 15 && y === 15 ? 130 : 255));
        const flat = field2(W, H, () => 135);
        const g = await gray(await run(crop, flat, W, H, noMask()));
        expect(g[15 * W + 15]).toBe(255);
      });

      it('ON: a medium pixel at a UNIQUE (flat-bright) location is KEPT (diagram-safe)', async () => {
        process.env.OCR_DISPLAY_BG_TRAIL = 'true';
        const crop = await makeImg(W, H, (x, y) => (x === 15 && y === 15 ? 130 : 255));
        // flat bright exactly at the pixel → unique content of any intensity → protected.
        const flat = field2(W, H, (x, y) => (x === 15 && y === 15 ? 255 : 135));
        const g = await gray(await run(crop, flat, W, H, noMask()));
        expect(g[15 * W + 15]).toBe(130);
      });

      it('ON: a medium trail pixel NEXT TO dark ink is KEPT (content seeds the halo)', async () => {
        process.env.OCR_DISPLAY_BG_TRAIL = 'true';
        // dark ink at (12,15); medium trail at (15,15) — 3px away, inside BG_HALO=8.
        const crop = await makeImg(W, H, (x, y) =>
          y === 15 && x === 12 ? 60 : y === 15 && x === 15 ? 130 : 255,
        );
        const flat = field2(W, H, () => 135);
        const g = await gray(await run(crop, flat, W, H, noMask()));
        expect(g[15 * W + 15]).toBe(130); // shielded by the ink halo → kept
      });
    });
  });

  // OCR_DISPLAY_WM_PERSISTENT_CORE: drop the flat-BLIND dark guards (C)/(F) inside
  // the mask so a DARK watermark core is removed, while the flat-AWARE guards (D)/(E)
  // keep all real content. persistentCoreEnabled() is read at call time, so the env
  // can be toggled per-test without a module reset.
  describe('aggressive flat-aware dark-core removal (OCR_DISPLAY_WM_PERSISTENT_CORE)', () => {
    const mask1 = (w: number): WatermarkMask => ({
      width: w,
      height: 1,
      data: Uint8Array.from(Array(w).fill(255)),
    });
    const cleanCore = (crop: Buffer, fd: number[]) =>
      cleanCropForDisplay(crop, {
        flat: flat(fd),
        mask: mask1(fd.length),
        region: { x0: 0, y0: 0, x1: fd.length, y1: 1 },
        pageWidth: fd.length,
        pageHeight: 1,
      });

    // Isolate the main mask pass: a 1-row all-dark crop is a degenerate "full-height
    // isolated column" for Pass 3, so disable the background/divider post-passes here.
    beforeEach(() => {
      process.env.OCR_DISPLAY_BG_CLEANUP = 'false';
      process.env.OCR_DISPLAY_DIVIDER_CLEANUP = 'false';
    });
    afterEach(() => {
      delete process.env.OCR_DISPLAY_WM_PERSISTENT_CORE;
      delete process.env.OCR_DISPLAY_BG_CLEANUP;
      delete process.env.OCR_DISPLAY_DIVIDER_CLEANUP;
    });

    it('DISABLED (env=false): a dark persistent watermark core is KEPT (absolute dark guard)', async () => {
      process.env.OCR_DISPLAY_WM_PERSISTENT_CORE = 'false'; // default is ON; this is the disable path
      // crop 60 == flat 60 (persistent dark, inside mask). Disabled → (C)/(F) protect it.
      const out = await rawOf(await cleanCore(await grayRow([60, 60]), [60, 60]));
      expect(out[0]).toBe(60);
    });

    it('DEFAULT (now ON): removes a dark persistent watermark core to white (no env set)', async () => {
      const out = await rawOf(await cleanCore(await grayRow([60, 60]), [60, 60]));
      expect(out[0]).toBe(255); // dark watermark core removed
    });

    it('ON (explicit): removes a dark persistent watermark core to white', async () => {
      process.env.OCR_DISPLAY_WM_PERSISTENT_CORE = 'true';
      const out = await rawOf(await cleanCore(await grayRow([60, 60]), [60, 60]));
      expect(out[0]).toBe(255); // dark watermark core removed
    });

    it('ON: still KEEPS unique dark content (flat bright → (E))', async () => {
      process.env.OCR_DISPLAY_WM_PERSISTENT_CORE = 'true';
      const out = await rawOf(await cleanCore(await grayRow([60, 60]), [255, 255]));
      expect(out[0]).toBe(60); // dark, but unique to this page → kept
    });

    it('ON: still KEEPS content drawn OVER the watermark (darker than bg → (D))', async () => {
      process.env.OCR_DISPLAY_WM_PERSISTENT_CORE = 'true';
      // crop 40 is darker than persistent bg 80 by > KEEP_MARGIN → unique ink on top.
      const out = await rawOf(await cleanCore(await grayRow([40, 40]), [80, 80]));
      expect(out[0]).toBe(40);
    });

    it('ON: the mask still gates — a dark core OUTSIDE the mask is KEPT', async () => {
      process.env.OCR_DISPLAY_WM_PERSISTENT_CORE = 'true';
      const out = await rawOf(
        await cleanCropForDisplay(await grayRow([60, 60]), {
          flat: flat([60, 60]),
          mask: { width: 2, height: 1, data: Uint8Array.from([0, 0]) },
          region: { x0: 0, y0: 0, x1: 2, y1: 1 },
          pageWidth: 2,
          pageHeight: 1,
        }),
      );
      expect(out[0]).toBe(60); // outside the large blob → never touched
    });
  });
});
