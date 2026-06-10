/*
 * Slice 2.4 validation bench — runs extractDrafts end-to-end on the Aakash
 * paper and prints the exact metrics format requested in the user's prompt.
 *
 * Requires:
 *   - Python OCR service running on PRINTED_OCR_URL (default localhost:8001)
 *     with HW_OCR_MODEL=paddle
 *   - PRINTED_OCR_VIA_PADDLE=true in env
 *
 * Without the Python service this falls through to tesseract.js, which DOES
 * NOT exercise the Slice 2.4 garbage-cluster filter (that's Python-only).
 * The script will warn loudly if it detects the fallback.
 *
 * Run:
 *   PRINTED_OCR_VIA_PADDLE=true \
 *   PRINTED_OCR_URL=http://localhost:8001 \
 *     npx ts-node scripts/_bench-neet-slice24.ts \
 *     "C:\\Users\\hp\\Downloads\\RE NEET PST 3 (1).pdf"
 *
 * Delete after capturing results.
 */
import { readFileSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { extractDrafts, shutdownTesseract } from '../src/shared/ocr-engine/ocr-engine';

// Noise patterns the Slice 2.4 fix should eliminate from stems.
const GARBAGE_PATTERNS = [
  /€o\b/, /\s@\s/, /\s@\)/, /\s\+\s\&\s/, /"@\s/, /\bef3C\b/, /3C @ 5 c 1/,
  /[©¥§¶]/, /\s@\s@\s/, /\s\@\s\&/,
];

const truncate = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n - 1) + '…');

const looksCorrupted = (stem: string): boolean => GARBAGE_PATTERNS.some((p) => p.test(stem));

const main = async (): Promise<void> => {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: ts-node scripts/_bench-neet-slice24.ts <pdf-path>');
    process.exit(1);
  }
  const viaPaddle = process.env.PRINTED_OCR_VIA_PADDLE === 'true' && !!process.env.PRINTED_OCR_URL;
  console.log(`[bench] reading ${path}`);
  console.log(`[bench] PaddleOCR path enabled: ${viaPaddle ? 'YES' : 'NO (tesseract fallback)'}`);
  if (!viaPaddle) {
    console.warn(
      '\n  WARNING: Slice 2.4 garbage filter only runs in the Python PaddleOCR path.\n' +
        '  Start the service and re-run with PRINTED_OCR_VIA_PADDLE=true to validate.\n',
    );
  }
  const bytes = readFileSync(path);
  console.log(`[bench] ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB`);

  // Stub putObject so figure uploads don't fail. We don't actually persist —
  // this bench is correctness-only. The dispatcher still receives the figure
  // crops; we just count them and (optionally) dump one to disk for visual
  // inspection.
  const figureCounter = { uploaded: 0, firstBytes: null as Buffer | null };
  const stubPutObject = async (_key: string, body: Buffer, _ct: string): Promise<void> => {
    figureCounter.uploaded += 1;
    if (figureCounter.firstBytes === null) figureCounter.firstBytes = body;
  };

  const storageKey = `bench/${randomUUID()}.pdf`;
  const t0 = Date.now();
  const result = await extractDrafts(bytes, 'application/pdf', {
    storageKey,
    putObject: stubPutObject,
    figureKeyPrefix: 'bench/figures',
  });
  const elapsedMs = Date.now() - t0;

  // ────────────────────────────────────────────────────────────────
  // METRICS
  // ────────────────────────────────────────────────────────────────
  const drafts = result.drafts;
  const totalQuestions = drafts.length;
  const totalFigures = drafts.reduce((s, d) => s + (d.figures?.length ?? 0), 0);
  const questionsWithFigures = drafts.filter((d) => (d.figures?.length ?? 0) > 0).length;
  const questionsWithoutFigures = totalQuestions - questionsWithFigures;
  const avgConfidence =
    drafts.length > 0 ? drafts.reduce((s, d) => s + d.confidence, 0) / drafts.length : 0;
  const corruptedStems = drafts.filter((d) => looksCorrupted(d.text));
  const corruptedStemCount = corruptedStems.length;

  console.log('\n========================================');
  console.log('BENCHMARK METRICS  (Slice 2.4)');
  console.log('========================================');
  console.log(`Total Questions Extracted   : ${totalQuestions}`);
  console.log(`Total Figures Extracted     : ${totalFigures}`);
  console.log(`Questions With Figures      : ${questionsWithFigures}`);
  console.log(`Questions Without Figures   : ${questionsWithoutFigures}`);
  console.log(`Average OCR Confidence      : ${(avgConfidence * 100).toFixed(1)}%`);
  console.log(`Corrupted Stem Count        : ${corruptedStemCount}`);
  console.log(`Provider                    : ${result.providerUsed}`);
  console.log(`Total Time                  : ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(`Figure Crops Uploaded       : ${figureCounter.uploaded}`);

  // ────────────────────────────────────────────────────────────────
  // FIRST 20 QUESTIONS — full stem + option count + figure count
  // ────────────────────────────────────────────────────────────────
  console.log('\n========================================');
  console.log('FIRST 20 EXTRACTED QUESTIONS');
  console.log('========================================');
  for (let i = 0; i < Math.min(20, drafts.length); i += 1) {
    const d = drafts[i];
    const figs = d.figures?.length ?? 0;
    const opts = d.options?.length ?? 0;
    const corrupt = looksCorrupted(d.text) ? ' ⚠ CORRUPT' : '';
    console.log(
      `\n#${d.position} (page ${d.sourcePageNumber ?? '?'}, ${d.detectedType}, conf=${(d.confidence * 100).toFixed(0)}%, opts=${opts}, figs=${figs})${corrupt}`,
    );
    console.log(`  stem: ${truncate(d.text, 240)}`);
    if (d.options && d.options.length > 0) {
      console.log(`  options: ${d.options.map((o) => ({ label: o.label ?? undefined, isCorrect: o.isCorrect ?? false })).map((o, j) => `(${j + 1}) ${truncate(o.label ?? '', 40)}`).join(' | ')}`);
    }
  }

  // ────────────────────────────────────────────────────────────────
  // CORRUPTED STEM AUDIT
  // ────────────────────────────────────────────────────────────────
  if (corruptedStemCount > 0) {
    console.log('\n========================================');
    console.log(`CORRUPTED STEMS (${corruptedStemCount} found — Slice 2.4 missed these)`);
    console.log('========================================');
    for (const d of corruptedStems.slice(0, 10)) {
      console.log(`\n#${d.position} (page ${d.sourcePageNumber}): ${truncate(d.text, 240)}`);
    }
  } else {
    console.log('\n✓ NO CORRUPTED STEMS DETECTED — garbage filter working as designed');
  }

  // ────────────────────────────────────────────────────────────────
  // FIGURE-HEAVY PAGES — sample audit
  // ────────────────────────────────────────────────────────────────
  const figsByPage = new Map<number, number>();
  for (const d of drafts) {
    const p = d.sourcePageNumber ?? 0;
    const n = d.figures?.length ?? 0;
    if (n > 0) figsByPage.set(p, (figsByPage.get(p) ?? 0) + n);
  }
  const topFigPages = [...figsByPage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log('\n========================================');
  console.log('FIGURE-HEAVY PAGES (top 5 by figure count)');
  console.log('========================================');
  for (const [p, n] of topFigPages) {
    const draftsOnPage = drafts.filter((d) => d.sourcePageNumber === p);
    const withFigs = draftsOnPage.filter((d) => (d.figures?.length ?? 0) > 0).length;
    console.log(`  page ${p}: ${n} figure(s) across ${withFigs}/${draftsOnPage.length} drafts`);
  }

  // ────────────────────────────────────────────────────────────────
  // SAMPLE FIGURE CROP — dump one to disk for visual inspection
  // ────────────────────────────────────────────────────────────────
  if (figureCounter.firstBytes) {
    const dumpPath = 'scripts/_bench-figure-sample.png';
    writeFileSync(dumpPath, figureCounter.firstBytes);
    console.log(`\n[bench] saved first figure crop to ${dumpPath} (${figureCounter.firstBytes.byteLength} bytes)`);
    console.log('         open this to visually verify the diagram was captured cleanly.');
  }

  console.log('\n========================================');
  console.log('VALIDATION CHECKLIST');
  console.log('========================================');
  console.log(`  ✓/✗  Total questions >= 180         : ${totalQuestions >= 180 ? '✓' : '✗'} (got ${totalQuestions})`);
  console.log(`  ✓/✗  No corrupted stems             : ${corruptedStemCount === 0 ? '✓' : '✗'} (${corruptedStemCount} corrupted)`);
  console.log(`  ✓/✗  Figures extracted              : ${totalFigures > 0 ? '✓' : '✗'} (${totalFigures} total)`);
  console.log(`  ✓/✗  Figure-bearing questions       : ${questionsWithFigures > 0 ? '✓' : '✗'} (${questionsWithFigures} drafts)`);
  console.log(`  ✓/✗  Provider is paddle (not tesseract): ${result.providerUsed.startsWith('paddle') ? '✓' : '✗'} (${result.providerUsed})`);
  console.log(`  ✓/✗  Avg confidence >= 85%          : ${avgConfidence >= 0.85 ? '✓' : '✗'} (${(avgConfidence * 100).toFixed(1)}%)`);

  await shutdownTesseract();
};

void main().catch((err) => {
  console.error('[bench] FAILED:', err);
  process.exit(1);
});
