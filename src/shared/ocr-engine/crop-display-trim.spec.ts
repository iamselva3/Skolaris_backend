import sharp from 'sharp';
import { trimDisplayCrop } from './crop-display-trim';

/**
 * Synthetic crops on a single-channel canvas: full-width ink bands stand in for a page
 * header / running title / institute banner, and a marker + stem + options stand in for
 * the question. This exercises the STRUCTURE-based header trim (top-side mirror of the
 * trailing-chrome trim) without any real PDF and without keying on any value.
 *
 * The header trim is tested in ISOLATION: the trailing/blank-margin trim and the
 * explanation strip are disabled so only trimHeaderBand runs.
 */
const W = 200;
const H = 600;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const paintRow = (px: Uint8Array, y0: number, y1: number): void => {
  for (let y = y0; y <= y1; y += 1)
    for (let x = 10; x < W - 10; x += 1) if (y >= 0 && y < H) px[y * W + x] = 0;
};

const paint = (px: Uint8Array, b: Box): void => {
  for (let y = b.y0; y <= b.y1; y += 1)
    for (let x = b.x0; x <= b.x1; x += 1) if (x >= 0 && x < W && y >= 0 && y < H) px[y * W + x] = 0;
};

const heightOf = async (b: Buffer): Promise<number> => (await sharp(b).metadata()).height ?? 0;

/** A clean MCQ: marker "12." at the given top, then stem + options below it. */
const questionBoxes = (markerY0: number): Box[] => [
  { x0: 10, y0: markerY0, x1: 28, y1: markerY0 + 14 }, // "12." marker
  { x0: 36, y0: markerY0, x1: 150, y1: markerY0 + 14 }, // stem line
  { x0: 10, y0: markerY0 + 60, x1: 150, y1: markerY0 + 74 }, // option A
  { x0: 10, y0: markerY0 + 90, x1: 150, y1: markerY0 + 104 }, // option B
];

/** P0 — a SPARSE diagram below a whitespace gap (wordless ink). The trailing trim must NOT
 *  cut through it. A short text footer below the gap (covered by word boxes) is still trimmed. */
describe('trimDisplayCrop — P0 diagram-below-gap protection', () => {
  beforeEach(() => {
    process.env.OCR_DISPLAY_CROP_TRIM = 'true'; // exercise the trailing/blank-margin trim
    process.env.OCR_DISPLAY_HEADER_TRIM = 'false';
    process.env.OCR_DISPLAY_FOOTER_TRIM = 'false';
    delete process.env.OCR_DISPLAY_EXPLANATION_TRIM;
  });
  afterEach(() => {
    delete process.env.OCR_DISPLAY_CROP_TRIM;
    delete process.env.OCR_DISPLAY_HEADER_TRIM;
    delete process.env.OCR_DISPLAY_FOOTER_TRIM;
  });

  const stemBlock = (): Box[] => [
    { x0: 10, y0: 20, x1: 150, y1: 34 }, // stem line 1
    { x0: 10, y0: 40, x1: 150, y1: 54 }, // stem line 2
  ];

  it('does NOT cut a sparse wordless diagram below the gap (keeps the whole crop)', async () => {
    const px = new Uint8Array(W * H).fill(255);
    for (const b of stemBlock()) paint(px, b); // top content block (rows 20..54)
    // big blank gap (rows 55..299), then a SPARSE diagram: thin strokes far apart, no word boxes
    for (let k = 0; k < 15; k += 1) paint(px, { x0: 80, y0: 300 + k * 6, x1: 120, y1: 300 + k * 6 });
    const crop = await sharp(Buffer.from(px), { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();

    const out = await trimDisplayCrop(crop, { words: stemBlock(), regionX0: 0, regionY0: 0 });
    // The diagram (rows ~300-384) must be retained ⇒ crop not shrunk to just the top block.
    expect(await heightOf(out)).toBeGreaterThanOrEqual(360);
  });

  it('still trims a short text footer below the gap (word-box ink, not a drawing)', async () => {
    const px = new Uint8Array(W * H).fill(255);
    for (const b of stemBlock()) paint(px, b);
    const footer: Box[] = [{ x0: 10, y0: 320, x1: 140, y1: 332 }]; // one short footer text line
    for (const b of footer) paint(px, b);
    const crop = await sharp(Buffer.from(px), { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();

    // words include the footer line ⇒ its ink is INSIDE a word box ⇒ not a drawing ⇒ trim proceeds.
    const out = await trimDisplayCrop(crop, { words: [...stemBlock(), ...footer], regionX0: 0, regionY0: 0 });
    expect(await heightOf(out)).toBeLessThan(H);
  });
});

describe('trimDisplayCrop — header / banner / top-logo trim (display-only)', () => {
  beforeEach(() => {
    process.env.OCR_DISPLAY_HEADER_TRIM = 'true';
    process.env.OCR_DISPLAY_CROP_TRIM = 'false'; // isolate the header pass
    delete process.env.OCR_DISPLAY_EXPLANATION_TRIM; // default OFF
  });
  afterEach(() => {
    delete process.env.OCR_DISPLAY_HEADER_TRIM;
    delete process.env.OCR_DISPLAY_CROP_TRIM;
  });

  it('removes a header band that sits above the marker with a clean whitespace gap', async () => {
    const markerY0 = 120;
    const px = new Uint8Array(W * H).fill(255);
    paintRow(px, 8, 40); // header band near the top
    for (const b of questionBoxes(markerY0)) paint(px, b); // gap 41..119, then the question
    const crop = await sharp(Buffer.from(px), { raw: { width: W, height: H, channels: 1 } })
      .png()
      .toBuffer();

    const out = await trimDisplayCrop(crop, {
      words: questionBoxes(markerY0),
      regionX0: 0,
      regionY0: 0,
      markerTopY: markerY0,
    });
    const h = await heightOf(out);
    // Cut just above the marker (markerTop - pad). Header (rows 8..40) must be gone.
    expect(h).toBeLessThan(H);
    expect(h).toBeGreaterThanOrEqual(H - markerY0 - 4);
    expect(h).toBeLessThanOrEqual(H - markerY0 + 8);
  });

  it('is a no-op when there is no marker anchor', async () => {
    const px = new Uint8Array(W * H).fill(255);
    paintRow(px, 8, 40);
    for (const b of questionBoxes(120)) paint(px, b);
    const crop = await sharp(Buffer.from(px), { raw: { width: W, height: H, channels: 1 } })
      .png()
      .toBuffer();

    const out = await trimDisplayCrop(crop, {
      words: questionBoxes(120),
      regionX0: 0,
      regionY0: 0,
      markerTopY: undefined,
    });
    expect(await heightOf(out)).toBe(H);
  });

  it('is a no-op when content touches the marker (no clean gap → same block)', async () => {
    const markerY0 = 120;
    const px = new Uint8Array(W * H).fill(255);
    paintRow(px, 8, markerY0 - 2); // ink runs right up to the marker → no gap
    for (const b of questionBoxes(markerY0)) paint(px, b);
    const crop = await sharp(Buffer.from(px), { raw: { width: W, height: H, channels: 1 } })
      .png()
      .toBuffer();

    const out = await trimDisplayCrop(crop, {
      words: questionBoxes(markerY0),
      regionX0: 0,
      regionY0: 0,
      markerTopY: markerY0,
    });
    expect(await heightOf(out)).toBe(H);
  });

  it('is a no-op when there is only blank margin above the marker (nothing to cut)', async () => {
    const markerY0 = 120;
    const px = new Uint8Array(W * H).fill(255);
    for (const b of questionBoxes(markerY0)) paint(px, b); // blank above the marker
    const crop = await sharp(Buffer.from(px), { raw: { width: W, height: H, channels: 1 } })
      .png()
      .toBuffer();

    const out = await trimDisplayCrop(crop, {
      words: questionBoxes(markerY0),
      regionX0: 0,
      regionY0: 0,
      markerTopY: markerY0,
    });
    expect(await heightOf(out)).toBe(H);
  });

  it('is a no-op when disabled', async () => {
    process.env.OCR_DISPLAY_HEADER_TRIM = 'false';
    const markerY0 = 120;
    const px = new Uint8Array(W * H).fill(255);
    paintRow(px, 8, 40);
    for (const b of questionBoxes(markerY0)) paint(px, b);
    const crop = await sharp(Buffer.from(px), { raw: { width: W, height: H, channels: 1 } })
      .png()
      .toBuffer();

    const out = await trimDisplayCrop(crop, {
      words: questionBoxes(markerY0),
      regionX0: 0,
      regionY0: 0,
      markerTopY: markerY0,
    });
    expect(await heightOf(out)).toBe(H);
  });
});
