# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: ocr-regression.spec.ts >> Biology_Cell → exactly 90 valid crops, deterministic
- Location: e2e\ocr-regression.spec.ts:54:7

# Error details

```
Error: delivered count for Biology_Cell

expect(received).toBe(expected) // Object.is equality

Expected: 90
Received: 92
```

# Test source

```ts
  9   |  *     missing/detached options, crop-boundary issues);
  10  |  *   • DETERMINISM — the two uploads produce identical delivered sets.
  11  |  * It writes a full per-paper report (every field the spec requires) to e2e/report/ and prints it.
  12  |  *
  13  |  * PREREQUISITES TO RUN (see e2e/README.md):
  14  |  *   E2E_BASE_URL          API base (default http://localhost:3000)
  15  |  *   E2E_EMAIL / E2E_PASSWORD [/ E2E_TENANT]   SUPER_ADMIN or TEACHER credentials
  16  |  *   REGRESSION_PDF_DIR    folder containing the 6 real PDFs (resolved by filename pattern)
  17  |  *   E2E_ITERATIONS        determinism iterations (default 2)
  18  |  * A paper whose PDF is absent is SKIPPED with a clear message (never a silent pass).
  19  |  */
  20  | import { test, expect, request as pwRequest, APIRequestContext } from '@playwright/test';
  21  | import { mkdirSync, writeFileSync } from 'fs';
  22  | import { join } from 'path';
  23  | import { PAPERS, resolvePdf, buildReport, deliveredSignature, formatReport, PaperReport } from './papers';
  24  | import { login, uploadAndExtract, Auth } from './client';
  25  | 
  26  | const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000';
  27  | const PDF_DIR = process.env.REGRESSION_PDF_DIR || '';
  28  | const ITERATIONS = Math.max(2, Number(process.env.E2E_ITERATIONS) || 2);
  29  | const REPORT_DIR = join(__dirname, 'report');
  30  | 
  31  | let api: APIRequestContext;
  32  | let auth: Auth;
  33  | const allReports: PaperReport[] = [];
  34  | 
  35  | test.beforeAll(async () => {
  36  |   if (!process.env.E2E_EMAIL || !process.env.E2E_PASSWORD)
  37  |     throw new Error('Set E2E_EMAIL and E2E_PASSWORD (SUPER_ADMIN/TEACHER) to run the regression suite.');
  38  |   api = await pwRequest.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true });
  39  |   auth = await login(api, process.env.E2E_EMAIL!, process.env.E2E_PASSWORD!, process.env.E2E_TENANT);
  40  |   mkdirSync(REPORT_DIR, { recursive: true });
  41  | });
  42  | 
  43  | test.afterAll(async () => {
  44  |   if (allReports.length) {
  45  |     writeFileSync(join(REPORT_DIR, 'regression-report.json'), JSON.stringify(allReports, null, 2));
  46  |     const summary = allReports.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.paper}: ${r.deliveredCount}/${r.expectedQuestions}`).join('\n');
  47  |     // eslint-disable-next-line no-console
  48  |     console.log(`\n================ REGRESSION SUMMARY ================\n${summary}\n===================================================`);
  49  |   }
  50  |   await api?.dispose();
  51  | });
  52  | 
  53  | for (const spec of PAPERS) {
  54  |   test(`${spec.label} → exactly ${spec.expected} valid crops, deterministic`, async () => {
  55  |     const pdf = PDF_DIR ? resolvePdf(PDF_DIR, spec) : null;
  56  |     test.skip(!pdf, `PDF for ${spec.label} not found in REGRESSION_PDF_DIR='${PDF_DIR}' (patterns: ${spec.patterns.join(', ')})`);
  57  | 
  58  |     // scanned 180-question papers can take many minutes; give the whole test room.
  59  |     test.setTimeout(30 * 60 * 1000);
  60  | 
  61  |     const runs = [];
  62  |     for (let i = 0; i < ITERATIONS; i += 1) {
  63  |       // eslint-disable-next-line no-console
  64  |       const r = await uploadAndExtract(api, auth, pdf!, `${spec.key}-iter${i}.pdf`, {
  65  |         onProgress: (p) =>
  66  |           process.stdout.write(`\r[${spec.key} #${i}] ${p.ocrStage ?? '...'} ${p.pageProcessed ?? 0}/${p.pageTotal ?? '?'} drafts=${p.draftCount ?? 0}   `),
  67  |       });
  68  |       runs.push(r);
  69  |     }
  70  |     process.stdout.write('\n');
  71  | 
  72  |     // DETERMINISM — every iteration's delivered set must be byte-identical.
  73  |     const sigs = runs.map((r) => deliveredSignature(r.drafts));
  74  |     const deterministic = sigs.every((s) => s === sigs[0]);
  75  | 
  76  |     const primary = runs[0];
  77  |     const report = buildReport(spec, primary.drafts, primary.authority, deterministic);
  78  |     allReports.push(report);
  79  | 
  80  |     // eslint-disable-next-line no-console
  81  |     console.log('\n' + formatReport(report));
  82  | 
  83  |     // STAGE TRACE on any miss — never stop at the number; name what was lost and where to look.
  84  |     if (!report.pass) {
  85  |       const trace: string[] = [`\n----- STAGE TRACE: ${spec.label} -----`];
  86  |       if (report.deliveredCount !== report.expectedQuestions) {
  87  |         trace.push(`COUNT LOST: delivered ${report.deliveredCount} vs expected ${report.expectedQuestions}.`);
  88  |         trace.push(`  missing numbers: [${report.missingQuestions.join(',')}]`);
  89  |         trace.push(`  duplicates: [${report.duplicates.join(',')}]  questionZero: ${report.questionZero}  impossible: ${report.impossibleSequences}`);
  90  |         trace.push(`  Python authority: ${primary.authority ? 'present (see ownership/missing/recovered above)' : 'NULL (hybrid analyze mode — wire upload report into authority endpoint for full ownership trace)'}`);
  91  |         // per-missing-question hint: the closest delivered neighbours by number
  92  |         const present = new Set(primary.drafts.map((d) => d.questionNumber).filter((n): n is number => typeof n === 'number'));
  93  |         for (const m of report.missingQuestions.slice(0, 25)) {
  94  |           const before = [...present].filter((n) => n < m).sort((a, b) => b - a)[0];
  95  |           const after = [...present].filter((n) => n > m).sort((a, b) => a - b)[0];
  96  |           trace.push(`  Q${m} MISSING — delivered neighbours: ${before ?? '∅'} → [${m}] → ${after ?? '∅'} (look for Q${m}'s marker/ownership between them)`);
  97  |         }
  98  |       }
  99  |       if (report.cropBoundaryIssues || report.missingOptions || report.detachedOptions)
  100 |         trace.push(`CROP/OPTION: invalidCrops=${report.cropBoundaryIssues} clippedOptions=${report.missingOptions} detached=${report.detachedOptions}`);
  101 |       if (!deterministic) trace.push(`NON-DETERMINISTIC: iteration signatures differ — engine is not reproducible.`);
  102 |       // eslint-disable-next-line no-console
  103 |       console.log(trace.join('\n'));
  104 |       writeFileSync(join(REPORT_DIR, `trace-${spec.key}.txt`), trace.join('\n'));
  105 |     }
  106 | 
  107 |     // HARD assertions — these are acceptance criteria, not soft checks.
  108 |     expect(deterministic, `determinism: signatures differ across ${ITERATIONS} uploads`).toBe(true);
> 109 |     expect(report.deliveredCount, `delivered count for ${spec.label}`).toBe(spec.expected);
      |                                                                        ^ Error: delivered count for Biology_Cell
  110 |     expect(report.cropCount, 'every delivered draft must carry a crop').toBe(report.deliveredCount);
  111 |     expect(report.cropBoundaryIssues, 'invalid crops').toBe(0);
  112 |     expect(report.duplicates, 'duplicate question numbers').toEqual([]);
  113 |     expect(report.questionZero, 'Question-0 / negative numbers').toBe(0);
  114 |     expect(report.missingQuestions, 'missing question numbers').toEqual([]);
  115 |     expect(report.impossibleSequences, 'impossible/backwards sequences').toBe(0);
  116 |     expect(report.missingOptions, 'questions with clipped (C/D) options').toBe(0);
  117 |     expect(report.detachedOptions, 'detached/orphan option blocks').toBe(0);
  118 |   });
  119 | }
  120 | 
```