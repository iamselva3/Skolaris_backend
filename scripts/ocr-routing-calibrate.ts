/*
 * Routing calibration CLI (Phase 4). Analyzes the `[ocr-routing]` decision logs
 * produced by shadow mode (HANDWRITING_OCR_ENABLED=true HANDWRITING_OCR_SHADOW=true)
 * and, when given labels, recommends an OCR_ROUTE_SCORE_THRESHOLD.
 *
 * Usage:
 *   npm run ocr:calibrate -- --log shadow.log
 *   npm run ocr:calibrate -- --log shadow.log --labels labels.json --target-precision 0.9
 *
 *   labels.json: { "tenants/../uploads/../a.pdf": "handwritten", "..b.png": "printed", ... }
 *
 * Collect shadow.log e.g.:  docker compose logs api | grep ocr-routing > shadow.log
 */
import { readFileSync } from 'fs';
import {
  evaluate,
  parseRoutingLogLines,
  recommendThreshold,
  summarize,
  type Label,
  type ThresholdResult,
} from '../src/shared/ocr-engine/calibration';

const argOf = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
};

const logPath = argOf('--log');
const labelsPath = argOf('--labels');
const targetPrecision = argOf('--target-precision');

if (!logPath) {
  // eslint-disable-next-line no-console
  console.error('Usage: npm run ocr:calibrate -- --log <shadow.log> [--labels <labels.json>] [--target-precision <0..1>]');
  process.exit(1);
}

const lines = readFileSync(logPath, 'utf8').split(/\r?\n/);
const records = parseRoutingLogLines(lines);

// eslint-disable-next-line no-console
const log = console.log;

log(`\n▸ Parsed ${records.length} routing decision(s) from ${logPath}\n`);
if (records.length === 0) {
  log('No [ocr-routing] lines found. Is shadow mode enabled and did any uploads run?');
  process.exit(0);
}

const s = summarize(records);
log('── Summary ─────────────────────────────────────────');
log(`  total:       ${s.total}`);
log(`  would route: ${s.routedCount} (${(s.routeRate * 100).toFixed(1)}%)`);
log(`  reasons:     ${JSON.stringify(s.reasonHistogram)}`);
log(`  pre-verdict: ${JSON.stringify(s.preVerdictHistogram)}`);
log(`  score dist:  ${JSON.stringify(s.scoreBuckets)}`);

if (!labelsPath) {
  log('\n(no --labels given — supply a label map to get precision/recall + a recommended threshold)\n');
  process.exit(0);
}

const labels = JSON.parse(readFileSync(labelsPath, 'utf8')) as Record<string, Label>;
const labeledCount = records.filter((r) => labels[r.storageKey] !== undefined).length;
const results = evaluate(records, labels);

log(`\n── Threshold sweep (positive = handwritten; ${labeledCount} labeled) ──`);
log('  thr   prec   rec    f1     acc    tp fp fn tn');
for (const r of results as ThresholdResult[]) {
  log(
    `  ${r.threshold.toFixed(2)}  ${r.precision.toFixed(2)}   ${r.recall.toFixed(2)}   ${r.f1.toFixed(2)}   ${r.accuracy.toFixed(2)}   ${r.tp}  ${r.fp}  ${r.fn}  ${r.tn}`,
  );
}

const minPrecision = targetPrecision ? Number(targetPrecision) : undefined;
const best = recommendThreshold(results, minPrecision !== undefined ? { minPrecision } : {});
log('\n── Recommendation ──────────────────────────────────');
if (!best) {
  log(`  No threshold meets the target precision ${minPrecision}. Loosen the target or collect more data.`);
} else {
  log(
    `  Set OCR_ROUTE_SCORE_THRESHOLD=${best.threshold.toFixed(2)}  ` +
      `(precision ${best.precision.toFixed(2)}, recall ${best.recall.toFixed(2)}, f1 ${best.f1.toFixed(2)})`,
  );
  log('  Defaults are estimates — re-run on a larger labeled set before going live.');
}
log('');
process.exit(0);
