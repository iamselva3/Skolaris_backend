import { Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { BBox, GutterCandidate, NumeralToken, PageFeatures, ShadowWord } from './contracts';

/**
 * PAGE ANALYZER — extracts VALUE-FREE structural features from a page image. Pure observability:
 * it reads the image (and optional OCR words) and returns features; it changes nothing and makes
 * no decisions. Detectors consume these features from the shared bus.
 *
 * Never imports the OCR engine. Independent of the live flow.
 */
const INK_DARK = 165; // luma below this = ink
const BUCKETS = 200; // ink-profile resolution

@Injectable()
export class PageAnalyzer {
  async analyze(pageImage: Buffer, pageIndex: number, words: ReadonlyArray<ShadowWord> = []): Promise<PageFeatures> {
    const { data, info } = await sharp(pageImage).greyscale().raw().toBuffer({ resolveWithObject: true });
    const W = info.width;
    const H = info.height;
    const bodyTop = Math.round(H * 0.12);
    const bodyBottom = Math.round(H * 0.92);
    const bodyH = Math.max(1, bodyBottom - bodyTop);

    // per-x ink fraction over the body
    const colInk = new Float32Array(W);
    let inkTotal = 0;
    for (let y = bodyTop; y < bodyBottom; y += 1) {
      const row = y * W;
      for (let x = 0; x < W; x += 1) {
        if (data[row + x] < INK_DARK) {
          colInk[x] += 1;
          inkTotal += 1;
        }
      }
    }
    for (let x = 0; x < W; x += 1) colInk[x] /= bodyH;
    const textDensity = inkTotal / (bodyH * W);

    // downsample to a fixed-width profile (stable across page sizes)
    const inkProfile: number[] = new Array(BUCKETS).fill(0);
    for (let b = 0; b < BUCKETS; b += 1) {
      const x0 = Math.floor((b / BUCKETS) * W);
      const x1 = Math.max(x0 + 1, Math.floor(((b + 1) / BUCKETS) * W));
      let s = 0;
      for (let x = x0; x < x1; x += 1) s += colInk[x];
      inkProfile[b] = s / (x1 - x0);
    }

    const gutters = this.findGutters(data, W, bodyTop, bodyBottom, bodyH, colInk);
    const numerals = this.liftNumerals(words);

    return {
      pageIndex,
      width: W,
      height: H,
      textDensity: Math.round(textDensity * 1000) / 1000,
      inkProfile,
      inkProfileBuckets: BUCKETS,
      bodyTop,
      bodyBottom,
      gutters,
      figureBboxes: [] as BBox[], // Phase-1 placeholder; figure/table extraction lands with the wide-content detector
      numerals,
      wordCount: words.length,
    };
  }

  /** Empty vertical runs in the central 25–75% band, with a row-level cleanliness fraction. */
  private findGutters(
    data: Buffer,
    W: number,
    bodyTop: number,
    bodyBottom: number,
    bodyH: number,
    colInk: Float32Array,
  ): GutterCandidate[] {
    const EMPTY = 0.02;
    const xL = Math.round(W * 0.25);
    const xR = Math.round(W * 0.75);
    const out: GutterCandidate[] = [];
    let cur = -1;
    const close = (start: number, end: number): void => {
      const width = end - start;
      if (width < Math.round(W * 0.012)) return;
      let cleanRows = 0;
      for (let y = bodyTop; y < bodyBottom; y += 1) {
        const row = y * W;
        let empty = true;
        for (let x = start; x < end && empty; x += 1) if (data[row + x] < INK_DARK) empty = false;
        if (empty) cleanRows += 1;
      }
      out.push({ x: Math.round(start + width / 2), width, cleanFraction: Math.round((cleanRows / bodyH) * 100) / 100 });
    };
    for (let x = xL; x <= xR; x += 1) {
      if (colInk[x] < EMPTY) {
        if (cur < 0) cur = x;
      } else if (cur >= 0) {
        close(cur, x);
        cur = -1;
      }
    }
    if (cur >= 0) close(cur, xR);
    return out.sort((a, b) => b.cleanFraction - a.cleanFraction).slice(0, 4);
  }

  /** RAW numeral tokens (text + leading integer + bbox). No shape classification here. */
  private liftNumerals(words: ReadonlyArray<ShadowWord>): NumeralToken[] {
    const out: NumeralToken[] = [];
    for (const w of words) {
      const t = (w.text ?? '').trim();
      if (!/^[-—–(]?\d/.test(t)) continue;
      const m = t.match(/\d{1,4}/);
      out.push({ text: t, value: m ? +m[0] : null, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 });
    }
    return out;
  }
}
