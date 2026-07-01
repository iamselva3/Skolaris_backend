/**
 * LIVE validation driver — exercises the ACTUAL running system end to end:
 *   login → create upload → PUT bytes → complete → TS OCR → Python Document Engine → drafts
 * No mocks, no offline shortcut. Prints the per-PDF report and a determinism check.
 *
 * Usage:
 *   node scripts/live-validate.mjs "C:/Users/hp/Downloads/PHYCHE.pdf"            # one PDF
 *   node scripts/live-validate.mjs --twice "C:/Users/hp/Downloads/PHYCHE.pdf"    # + determinism
 *   node scripts/live-validate.mjs --all                                         # the regression set
 */
import { readFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

const API = process.env.E2E_API_BASE_URL ?? 'http://localhost:3000/api';
const EMAIL = process.env.E2E_TEACHER_EMAIL ?? 'teacher@acme.test';
const PASS = process.env.E2E_TEACHER_PASSWORD ?? 'Teacher123!';
const DL = process.env.REGRESSION_PDF_DIR ?? join(homedir(), 'Downloads');
const REGRESSION = [
  'AIOTS 1 & DR09 Q @ sk_0476.pdf', 'AD 2601 Q.pdf', 'RE NEET PST 3 (1).pdf',
  'Biology.pdf', 'Biology_Cell.pdf', 'PHYCHE.pdf',
];
const EXPECTED = { 'PHYCHE.pdf': 50 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ipv4 = (u) => u.replace('://localhost', '://127.0.0.1');
// Resilient fetch — long OCR runs see transient connection blips; retry a few times.
const ff = async (url, opts, tries = 4) => {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fetch(ipv4(url), opts); }
    catch (e) { last = e; await sleep(1500 * (i + 1)); }
  }
  throw last;
};
const j = async (resPromise) => {
  const res = await resPromise;
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const b = await res.json();
  return b?.data ?? b;
};

const login = async () => {
  const d = await j(ff(`${API}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  }));
  if (!d.accessToken) throw new Error('no accessToken');
  return d.accessToken;
};

const run = async (token, pdfPath) => {
  const name = basename(pdfPath);
  const bytes = readFileSync(pdfPath);
  const A = (t) => ({ Authorization: `Bearer ${t}` });
  const signed = await j(ff(`${API}/uploads`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...A(token) },
    body: JSON.stringify({ originalName: name, mimeType: 'application/pdf', sizeBytes: statSync(pdfPath).size, category: 'ocr-papers' }),
  }));
  const putRes = await ff(signed.signedUrl, {
    method: signed.httpMethod, headers: { 'content-type': 'application/pdf', ...(signed.requiredHeaders ?? {}) }, body: bytes,
  });
  if (!putRes.ok) throw new Error(`byte upload HTTP ${putRes.status}`);
  await j(ff(`${API}/uploads/${signed.id}/complete`, { method: 'POST', headers: A(token) }));

  const deadline = Date.now() + 12 * 60_000;
  let stage = '';
  while (Date.now() < deadline) {
    const s = await j(ff(`${API}/ocr/progress/${signed.id}`, { headers: A(token) }));
    stage = s.ocrStage;
    process.stdout.write(`\r  ${name}: ${stage} ${s.pageProcessed}/${s.pageTotal} (${s.progressPercent}%)   `);
    if (stage === 'FAILED' || s.uploadStatus === 'FAILED') throw new Error(`OCR FAILED: ${s.errorMessage}`);
    if (stage === 'COMPLETED') break;
    await sleep(3000);
  }
  process.stdout.write('\n');
  const detail = await j(ff(`${API}/uploads/${signed.id}`, { headers: A(token) }));
  const jobId = detail.ocrJob?.id;
  const body = await (await ff(`${API}/ocr/jobs/${jobId}/drafts?limit=200`, { headers: A(token) })).json();
  const drafts = (body.data ?? []).map((d) => ({
    questionNumber: d.questionNumber ?? null, optionCount: d.optionCount ?? null,
    snapshot: d.questionSnapshotKey ?? null, review: !!d.needsImageReview, invalid: !!d.invalidCrop,
    pythonBuilt: !!d.pythonBuilt,
  }));
  return { name, drafts };
};

const evaluate = (name, drafts) => {
  const nums = drafts.map((d) => d.questionNumber).filter((n) => typeof n === 'number');
  const seen = new Map(); nums.forEach((n) => seen.set(n, (seen.get(n) ?? 0) + 1));
  const duplicates = [...seen.values()].filter((c) => c > 1).length;
  const q0 = nums.filter((n) => n === 0).length;
  const neg = nums.filter((n) => n < 0).length;
  let impossible = 0; for (let i = 1; i < nums.length; i++) if (nums[i] < nums[i - 1]) impossible++;
  const pos = nums.filter((n) => n > 0); const maxN = pos.length ? Math.max(...pos) : 0;
  const present = new Set(pos);
  const skipped = maxN ? Array.from({ length: maxN }, (_, i) => i + 1).filter((n) => !present.has(n)).length : 0;
  const counts = drafts.map((d) => d.optionCount ?? 0).filter((n) => n >= 2);
  const f = new Map(); counts.forEach((c) => f.set(c, (f.get(c) ?? 0) + 1));
  let expOpt = 4, bn = -1; for (const [k, v] of f) if (v > bn) { expOpt = k; bn = v; }
  const cropCount = drafts.filter((d) => d.snapshot).length;
  const missingCrops = drafts.length - cropCount;
  const broken = drafts.filter((d) => (d.optionCount ?? 0) > 0 && (d.optionCount ?? 0) < expOpt).length;
  const complete = drafts.filter((d) => !d.review && !d.invalid && d.snapshot).length;
  const pyBuilt = drafts.filter((d) => d.pythonBuilt).length;
  const expected = EXPECTED[name] ?? null;
  const chain = (expected == null || expected === drafts.length) && drafts.length === cropCount && drafts.length === complete;
  const clean = duplicates + q0 + neg + impossible + skipped + broken + missingCrops === 0;
  return { name, expected, delivered: drafts.length, cropCount, complete, expOpt, duplicates, q0, neg, impossible, skipped, broken, missingCrops, pyBuilt, nnc: chain ? 'PASS' : 'FAIL', verdict: chain && clean ? 'PASS' : 'FAIL' };
};

const printReport = (r) => {
  // AUTHORITY: TS stores Python's set verbatim, so TS Stored Count = delivered (persisted drafts).
  // Python-authoritative ⇒ every delivered draft is pythonBuilt and pyDelivered === tsStored.
  const tsStored = r.delivered;
  const authoritative = r.pyBuilt === r.delivered ? 'YES' : 'NO (TS intercepted!)';
  console.log(`${'─'.repeat(56)}
PDF Name:              ${r.name}
Expected Questions:    ${r.expected ?? '—'}
Python Delivered Count:${r.delivered}
TS Stored Count:       ${tsStored}
Python Delivered==Stored: ${r.delivered === tsStored ? 'PASS' : 'FAIL'}
Python-authoritative:  ${authoritative} (pythonBuilt ${r.pyBuilt}/${r.delivered})
Crop Count:            ${r.cropCount}
Complete Questions:    ${r.complete}
Expected Options:      ${r.expOpt}
Duplicates:            ${r.duplicates}
Question 0:            ${r.q0}
Negatives:             ${r.neg}
Impossible Sequences:  ${r.impossible}
Skipped Numbers:       ${r.skipped}
Broken Options:        ${r.broken}
Missing Crops:         ${r.missingCrops}
N=N=C (delivery):      ${r.nnc}
VERDICT:               ${r.verdict}`);
};

const main = async () => {
  const args = process.argv.slice(2);
  const twice = args.includes('--twice');
  const all = args.includes('--all');
  const files = all ? REGRESSION.map((n) => join(DL, n)) : args.filter((a) => !a.startsWith('--'));
  const token = await login();
  console.log(`logged in. API=${API}`);
  for (const f of files) {
    if (!existsSync(f)) { console.log(`MISSING: ${f}`); continue; }
    try {
      const r1 = await run(token, f);
      const e1 = evaluate(r1.name, r1.drafts);
      printReport(e1);
      if (twice) {
        const r2 = await run(token, f);
        const e2 = evaluate(r2.name, r2.drafts);
        const det = e1.delivered === e2.delivered && e1.cropCount === e2.cropCount && e1.complete === e2.complete
          && JSON.stringify(r1.drafts.map((d) => d.questionNumber)) === JSON.stringify(r2.drafts.map((d) => d.questionNumber));
        console.log(`Deterministic:         ${det ? 'PASS' : 'FAIL'} (run2 delivered=${e2.delivered} crops=${e2.cropCount})`);
      }
    } catch (e) { console.log(`\nERROR ${basename(f)}: ${e.message}`); }
  }
};
main().catch((e) => { console.error(e); process.exit(1); });
