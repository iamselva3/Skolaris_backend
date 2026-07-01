/**
 * LIVE OCR REGRESSION SUITE — hard acceptance, not improvement metrics.
 *
 * For each regression paper it uploads the REAL PDF through the actual running pipeline (login →
 * upload → OCR → drafts), TWICE, and asserts:
 *   • deliveredCount === expected (90 / 85 / 50 / 180 / 180 / 180) — 179/180 is a FAIL;
 *   • every delivered crop is valid (has a crop image, not invalidCrop);
 *   • zero of every historical failure category (duplicates, Q0, impossible/unordered, missing numbers,
 *     missing/detached options, crop-boundary issues);
 *   • DETERMINISM — the two uploads produce identical delivered sets.
 * It writes a full per-paper report (every field the spec requires) to e2e/report/ and prints it.
 *
 * PREREQUISITES TO RUN (see e2e/README.md):
 *   E2E_BASE_URL          API base (default http://localhost:3000)
 *   E2E_EMAIL / E2E_PASSWORD [/ E2E_TENANT]   SUPER_ADMIN or TEACHER credentials
 *   REGRESSION_PDF_DIR    folder containing the 6 real PDFs (resolved by filename pattern)
 *   E2E_ITERATIONS        determinism iterations (default 2)
 * A paper whose PDF is absent is SKIPPED with a clear message (never a silent pass).
 */
import { test, expect, request as pwRequest, APIRequestContext } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PAPERS, resolvePdf, buildReport, deliveredSignature, formatReport, PaperReport } from './papers';
import { login, uploadAndExtract, Auth } from './client';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000';
const PDF_DIR = process.env.REGRESSION_PDF_DIR || '';
const ITERATIONS = Math.max(2, Number(process.env.E2E_ITERATIONS) || 2);
const REPORT_DIR = join(__dirname, 'report');

let api: APIRequestContext;
let auth: Auth;
const allReports: PaperReport[] = [];

test.beforeAll(async () => {
  if (!process.env.E2E_EMAIL || !process.env.E2E_PASSWORD)
    throw new Error('Set E2E_EMAIL and E2E_PASSWORD (SUPER_ADMIN/TEACHER) to run the regression suite.');
  api = await pwRequest.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true });
  auth = await login(api, process.env.E2E_EMAIL!, process.env.E2E_PASSWORD!, process.env.E2E_TENANT);
  mkdirSync(REPORT_DIR, { recursive: true });
});

test.afterAll(async () => {
  if (allReports.length) {
    writeFileSync(join(REPORT_DIR, 'regression-report.json'), JSON.stringify(allReports, null, 2));
    const summary = allReports.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.paper}: ${r.deliveredCount}/${r.expectedQuestions}`).join('\n');
    // eslint-disable-next-line no-console
    console.log(`\n================ REGRESSION SUMMARY ================\n${summary}\n===================================================`);
  }
  await api?.dispose();
});

for (const spec of PAPERS) {
  test(`${spec.label} → exactly ${spec.expected} valid crops, deterministic`, async () => {
    const pdf = PDF_DIR ? resolvePdf(PDF_DIR, spec) : null;
    test.skip(!pdf, `PDF for ${spec.label} not found in REGRESSION_PDF_DIR='${PDF_DIR}' (patterns: ${spec.patterns.join(', ')})`);

    // scanned 180-question papers can take many minutes; give the whole test room.
    test.setTimeout(30 * 60 * 1000);

    const runs = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      // eslint-disable-next-line no-console
      const r = await uploadAndExtract(api, auth, pdf!, `${spec.key}-iter${i}.pdf`, {
        onProgress: (p) =>
          process.stdout.write(`\r[${spec.key} #${i}] ${p.ocrStage ?? '...'} ${p.pageProcessed ?? 0}/${p.pageTotal ?? '?'} drafts=${p.draftCount ?? 0}   `),
      });
      runs.push(r);
    }
    process.stdout.write('\n');

    // DETERMINISM — every iteration's delivered set must be byte-identical.
    const sigs = runs.map((r) => deliveredSignature(r.drafts));
    const deterministic = sigs.every((s) => s === sigs[0]);

    const primary = runs[0];
    const report = buildReport(spec, primary.drafts, primary.authority, deterministic);
    allReports.push(report);

    // eslint-disable-next-line no-console
    console.log('\n' + formatReport(report));

    // STAGE TRACE on any miss — never stop at the number; name what was lost and where to look.
    if (!report.pass) {
      const trace: string[] = [`\n----- STAGE TRACE: ${spec.label} -----`];
      if (report.deliveredCount !== report.expectedQuestions) {
        trace.push(`COUNT LOST: delivered ${report.deliveredCount} vs expected ${report.expectedQuestions}.`);
        trace.push(`  missing numbers: [${report.missingQuestions.join(',')}]`);
        trace.push(`  duplicates: [${report.duplicates.join(',')}]  questionZero: ${report.questionZero}  impossible: ${report.impossibleSequences}`);
        trace.push(`  Python authority: ${primary.authority ? 'present (see ownership/missing/recovered above)' : 'NULL (hybrid analyze mode — wire upload report into authority endpoint for full ownership trace)'}`);
        // per-missing-question hint: the closest delivered neighbours by number
        const present = new Set(primary.drafts.map((d) => d.questionNumber).filter((n): n is number => typeof n === 'number'));
        for (const m of report.missingQuestions.slice(0, 25)) {
          const before = [...present].filter((n) => n < m).sort((a, b) => b - a)[0];
          const after = [...present].filter((n) => n > m).sort((a, b) => a - b)[0];
          trace.push(`  Q${m} MISSING — delivered neighbours: ${before ?? '∅'} → [${m}] → ${after ?? '∅'} (look for Q${m}'s marker/ownership between them)`);
        }
      }
      if (report.cropBoundaryIssues || report.missingOptions || report.detachedOptions)
        trace.push(`CROP/OPTION: invalidCrops=${report.cropBoundaryIssues} clippedOptions=${report.missingOptions} detached=${report.detachedOptions}`);
      if (!deterministic) trace.push(`NON-DETERMINISTIC: iteration signatures differ — engine is not reproducible.`);
      // eslint-disable-next-line no-console
      console.log(trace.join('\n'));
      writeFileSync(join(REPORT_DIR, `trace-${spec.key}.txt`), trace.join('\n'));
    }

    // HARD assertions — these are acceptance criteria, not soft checks.
    expect(deterministic, `determinism: signatures differ across ${ITERATIONS} uploads`).toBe(true);
    expect(report.deliveredCount, `delivered count for ${spec.label}`).toBe(spec.expected);
    expect(report.cropCount, 'every delivered draft must carry a crop').toBe(report.deliveredCount);
    expect(report.cropBoundaryIssues, 'invalid crops').toBe(0);
    expect(report.duplicates, 'duplicate question numbers').toEqual([]);
    expect(report.questionZero, 'Question-0 / negative numbers').toBe(0);
    expect(report.missingQuestions, 'missing question numbers').toEqual([]);
    expect(report.impossibleSequences, 'impossible/backwards sequences').toBe(0);
    expect(report.missingOptions, 'questions with clipped (C/D) options').toBe(0);
    expect(report.detachedOptions, 'detached/orphan option blocks').toBe(0);
  });
}
