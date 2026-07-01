import sharp from 'sharp';
import { stripExplanationBlock, type ExplWBox } from './crop-strip-explanation';

/**
 * Synthetic crops: a single-channel canvas where every word box is painted solid black
 * (ink inside the boxes = a TEXT block). Figures are painted as ink OUTSIDE word boxes or
 * as a full-width ruled line. This exercises the STRUCTURE-based decision without any real
 * PDF and without ever keying on explanation words.
 */
const W = 200;
const H = 600;

const paint = (px: Uint8Array, b: { x0: number; y0: number; x1: number; y1: number }): void => {
  for (let y = b.y0; y <= b.y1; y += 1)
    for (let x = b.x0; x <= b.x1; x += 1) if (x >= 0 && x < W && y >= 0 && y < H) px[y * W + x] = 0;
};

/** Build a crop PNG by painting every word box black (plus any extra ink rects). */
const makeCrop = async (words: ExplWBox[], extraInk: Array<{ x0: number; y0: number; x1: number; y1: number }> = []): Promise<Buffer> => {
  const px = new Uint8Array(W * H).fill(255);
  for (const w of words) paint(px, w);
  for (const r of extraInk) paint(px, r);
  return sharp(Buffer.from(px), { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
};

const T = (text: string, x0: number, y0: number, x1: number, y1: number): ExplWBox => ({ text, x0, y0, x1, y1 });

/** A complete MCQ: number + stem + four contiguous options. */
const completeQuestion = (): ExplWBox[] => [
  T('12.', 10, 10, 28, 22),
  T('What', 36, 10, 90, 22),
  T('is', 96, 10, 120, 22),
  T('shown', 10, 30, 80, 42),
  T('here', 86, 30, 140, 42),
  T('A.', 10, 120, 24, 132),
  T('alpha', 32, 120, 150, 132),
  T('B.', 10, 150, 24, 162),
  T('beta', 32, 150, 150, 162),
  T('C.', 10, 180, 24, 192),
  T('gamma', 32, 180, 150, 192),
  T('D.', 10, 210, 24, 222),
  T('delta', 32, 210, 150, 222),
];

/** Explanation footer rows well below a whitespace gap. */
const footerRows = (): ExplWBox[] => [
  T('the', 10, 300, 60, 312),
  T('correct', 66, 300, 150, 312),
  T('choice', 10, 318, 90, 330),
  T('because', 96, 318, 190, 330),
  T('shells', 10, 336, 80, 348),
  T('fill', 86, 336, 130, 348),
];

const heightOf = async (b: Buffer): Promise<number> => (await sharp(b).metadata()).height ?? 0;
const opts = { regionX0: 0, regionY0: 0 };

describe('stripExplanationBlock (structure-based explanation/footer removal)', () => {
  beforeEach(() => { process.env.OCR_DISPLAY_EXPLANATION_TRIM = 'true'; });
  afterEach(() => { delete process.env.OCR_DISPLAY_EXPLANATION_TRIM; });

  it('REMOVES a whitespace-separated text footer below a complete question', async () => {
    const words = [...completeQuestion(), ...footerRows()];
    const crop = await makeCrop(words);
    const res = await stripExplanationBlock(crop, { ...opts, words });
    const h = await heightOf(res.crop);
    expect(h).toBeLessThan(H); // a cut happened
    expect(h).toBeGreaterThanOrEqual(222); // options (bottom 222) fully preserved
    expect(h).toBeLessThan(300); // footer (starts 300) removed
    // footer words dropped from the returned list, option/stem words kept
    expect(res.words.some((w) => w.y0 >= 300)).toBe(false);
    expect(res.words.some((w) => w.text === 'D.')).toBe(true);
  });

  it('NO-OP — disabled by default (no env flag)', async () => {
    delete process.env.OCR_DISPLAY_EXPLANATION_TRIM;
    const words = [...completeQuestion(), ...footerRows()];
    const crop = await makeCrop(words);
    const res = await stripExplanationBlock(crop, { ...opts, words });
    expect(res.crop).toBe(crop); // exact same buffer
  });

  it('NO-OP — no whitespace-separated block below the options', async () => {
    const words = completeQuestion(); // nothing below the options
    const crop = await makeCrop(words);
    const res = await stripExplanationBlock(crop, { ...opts, words });
    expect(await heightOf(res.crop)).toBe(H);
  });

  it('NO-OP — options are incomplete (only A and B detected)', async () => {
    const words = [
      T('12.', 10, 10, 28, 22), T('What', 36, 10, 90, 22), T('is', 96, 10, 120, 22),
      T('A.', 10, 120, 24, 132), T('alpha', 32, 120, 150, 132),
      T('B.', 10, 150, 24, 162), T('beta', 32, 150, 150, 162),
      ...footerRows(),
    ];
    const crop = await makeCrop(words);
    const res = await stripExplanationBlock(crop, { ...opts, words });
    expect(await heightOf(res.crop)).toBe(H);
  });

  it('NO-OP — a ruled line below the gap (table/figure) is protected', async () => {
    const words = [...completeQuestion(), T('row', 10, 300, 60, 312), T('label', 66, 300, 150, 312)];
    // full-width horizontal rule across the footer band
    const crop = await makeCrop(words, [{ x0: 0, y0: 320, x1: W - 1, y1: 322 }]);
    const res = await stripExplanationBlock(crop, { ...opts, words });
    expect(await heightOf(res.crop)).toBe(H);
  });

  it('NO-OP — a figure below the gap (ink outside word boxes) is protected', async () => {
    const words = [...completeQuestion(), T('fig', 10, 300, 40, 312), T('cap', 46, 300, 80, 312)];
    // A diagram below the gap: ink spread widely OUTSIDE any word box (dots forming a
    // figure), each ≤ rule length, dominating the band → low in-box text coverage.
    const ink: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
    for (let row = 0; row < 12; row += 1)
      for (let col = 0; col < 20; col += 1) {
        const x = 6 + col * 9;
        const y = 330 + row * 9;
        ink.push({ x0: x, y0: y, x1: x + 2, y1: y + 2 });
      }
    const crop = await makeCrop(words, ink);
    const res = await stripExplanationBlock(crop, { ...opts, words });
    expect(await heightOf(res.crop)).toBe(H);
  });

  it('NO-OP — assertion/reason question is protected outright', async () => {
    const words = [
      T('12.', 10, 10, 28, 22), T('Assertion', 36, 10, 130, 22), T('something', 10, 30, 120, 42),
      T('Reason', 10, 50, 70, 62), T('other', 76, 50, 130, 62),
      T('A.', 10, 120, 24, 132), T('x', 32, 120, 60, 132),
      T('B.', 10, 150, 24, 162), T('y', 32, 150, 60, 162),
      T('C.', 10, 180, 24, 192), T('z', 32, 180, 60, 192),
      T('D.', 10, 210, 24, 222), T('w', 32, 210, 60, 222),
      ...footerRows(),
    ];
    const crop = await makeCrop(words);
    const res = await stripExplanationBlock(crop, { ...opts, words });
    expect(await heightOf(res.crop)).toBe(H);
  });

  it('NO-OP — a real next-question marker below the gap is never cut', async () => {
    const words = [
      ...completeQuestion(),
      T('13.', 10, 300, 28, 312), T('Next', 36, 300, 90, 312), T('question', 96, 300, 190, 312),
    ];
    const crop = await makeCrop(words);
    const res = await stripExplanationBlock(crop, { ...opts, words });
    expect(await heightOf(res.crop)).toBe(H);
  });

  it('NO-OP — no stem above the options (options-only fragment)', async () => {
    const words = [
      T('A.', 10, 120, 24, 132), T('alpha', 32, 120, 150, 132),
      T('B.', 10, 150, 24, 162), T('beta', 32, 150, 150, 162),
      T('C.', 10, 180, 24, 192), T('gamma', 32, 180, 150, 192),
      T('D.', 10, 210, 24, 222), T('delta', 32, 210, 150, 222),
      ...footerRows(),
    ];
    const crop = await makeCrop(words);
    const res = await stripExplanationBlock(crop, { ...opts, words });
    expect(await heightOf(res.crop)).toBe(H);
  });
});
