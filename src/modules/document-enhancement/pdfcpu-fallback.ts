/*
 * DOCUMENT ENHANCEMENT — Phase 2 SECONDARY package: pdfcpu fallback cleaner.
 *
 * Runs ONLY when pdf-lib could not act (it errored / produced no output) AND a
 * pdfcpu binary is available on PATH. It works from the ORIGINAL bytes — never
 * from pdf-lib's output — so no object is mutated by two packages and nothing is
 * stacked. Its single safe operation is removing the same unambiguous decorative
 * annotation subtypes (Watermark / Stamp) via `pdfcpu annotations remove`, which
 * is object-level and does NOT touch content streams or rasterize.
 *
 * pdfcpu is OPTIONAL infrastructure: if it is not installed the fallback is a
 * clean no-op and the chain ends at KEEP PIXELS. There is NO env tuning — the
 * only thing probed is whether the `pdfcpu` command exists.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v4 as uuid } from 'uuid';
import { Candidate } from './pdf-lib-enhancer';

const DECORATIVE_ANNOTATION_SUBTYPES = ['Watermark', 'Stamp'];

let availableCache: boolean | null = null;

/** True if a `pdfcpu` binary responds on PATH. Cached after the first probe. */
export const isPdfcpuAvailable = (): boolean => {
  if (availableCache !== null) return availableCache;
  try {
    execFileSync('pdfcpu', ['version'], { stdio: 'ignore', timeout: 5000 });
    availableCache = true;
  } catch {
    availableCache = false;
  }
  return availableCache;
};

export interface PdfcpuResult {
  available: boolean;
  removed: Candidate[];
  /** New PDF bytes — present only when pdfcpu actually changed the document. */
  pdf: Buffer | null;
}

/**
 * Attempt decorative-annotation removal with pdfcpu, from the ORIGINAL bytes.
 * No-op (pdf:null) when pdfcpu is unavailable or removed nothing.
 */
export const fallbackWithPdfcpu = (originalBytes: Buffer): PdfcpuResult => {
  if (!isPdfcpuAvailable()) return { available: false, removed: [], pdf: null };

  const dir = mkdtempSync(join(tmpdir(), 'skolaris-enh-'));
  const inPath = join(dir, `${uuid()}.pdf`);
  const outPath = join(dir, `${uuid()}.pdf`);
  try {
    writeFileSync(inPath, originalBytes);
    // pdfcpu annotations remove -- inFile outFile [annotType...]
    execFileSync(
      'pdfcpu',
      ['annotations', 'remove', '--', inPath, outPath, ...DECORATIVE_ANNOTATION_SUBTYPES],
      { stdio: 'ignore', timeout: 60000 },
    );
    const out = readFileSync(outPath);
    // pdfcpu rewrites even on no-match; only treat as a change if bytes actually differ.
    if (out.length === originalBytes.length && out.equals(originalBytes)) {
      return { available: true, removed: [], pdf: null };
    }
    return {
      available: true,
      removed: [
        {
          kind: 'annotation',
          reason: 'decorative Watermark/Stamp annotation(s) removed via pdfcpu fallback',
        },
      ],
      pdf: out,
    };
  } catch {
    // Any pdfcpu failure ⇒ no output ⇒ KEEP PIXELS.
    return { available: true, removed: [], pdf: null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
