/**
 * STRESS validation suite — adversarial end-to-end validation of the OCR → Python Document Engine.
 *
 * GOAL: break the engine, not prove it. Drives the REAL running system with NO mocks, NO offline
 * shortcut, NO Python bypass, NO page-render bypass:
 *
 *   login → create upload → PUT bytes → complete → TS OCR → Python /build-document
 *         → ownership graph → completeness → crop build/repair/validate → Stage1/Stage2 N=N=C
 *         → deliver → TS stores → GET /ocr/jobs/:id/authority (Python's own proof object)
 *
 * We do NOT trust Python's self-reported stage booleans alone — we RECOMPUTE the N=N=C equality chain
 * from the raw counts AND cross-check Python's delivered count against the count TS actually PERSISTED
 * (draftCounts from /ocr/jobs/:id). A golden-rule violation (TS interception, or a silent wrong
 * delivery) is a FAIL. Conservative withholding (deliver=false → review) is NOT a failure — it is the
 * "never silently deliver" safety net working; we report it as WITHHELD with the engine's own reasons.
 *
 * THREE-STATE per-PDF verdict:
 *   PASS (DELIVERED)   deliver=true, intercepted=false, N=N=C all-equal, no anomalies, expected matches.
 *   WITHHELD (REVIEW)  deliver=false, intercepted=false, nothing silently delivered. Honest non-delivery.
 *   FAIL               intercepted=true | deliver=true with a broken set | persist drift | nondeterminism | crash.
 *
 * Usage:
 *   node scripts/stress-validate.mjs --suite          # 6 regression + 4 unseen (full attack set)
 *   node scripts/stress-validate.mjs --regression | --unseen | --determinism
 *   node scripts/stress-validate.mjs [--twice] "C:/path/x.pdf"
 *
 * Exit code: 0 only if NO golden-rule FAIL across the suite; 1 otherwise (CI-friendly).
 */
import { readFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

const API = process.env.E2E_API_BASE_URL ?? 'http://localhost:3000/api';
const EMAIL = process.env.E2E_TEACHER_EMAIL ?? 'teacher@acme.test';
const PASS = process.env.E2E_TEACHER_PASSWORD ?? 'Teacher123!';
const DL = process.env.REGRESSION_PDF_DIR ?? join(homedir(), 'Downloads');
const DRAFT_PAGE = 200; // hard server cap on the drafts list endpoint

const REGRESSION = [
  'AIOTS 1 & DR09 Q @ sk_0476.pdf', 'AD 2601 Q.pdf', 'RE NEET PST 3 (1).pdf',
  'Biology.pdf', 'Biology_Cell.pdf', 'PHYCHE.pdf',
];
const UNSEEN = [
  'Paper_20210816163051.pdf', 'aswin.pdf', '25 REP @ sk.pdf', 'one-mark_watermark_watermark.pdf',
];
const DETERMINISM = new Set(['AD 2601 Q.pdf', 'PHYCHE.pdf', 'Paper_20210816163051.pdf']);
const EXPECTED = { 'PHYCHE.pdf': 50, 'RE NEET PST 3 (1).pdf': 180 };

// ── rejection-reason → issue bucket (golden rule 8: never silently drop a rejection) ──
const CATEGORY_RULES = [
  ['crossPage', /cross[\s_-]?page|continuation|continued|spans?\s+page|next\s+page/i],
  ['crossColumn', /cross[\s_-]?column|column|gutter|reflow/i],
  ['diagram', /diagram|figure|image|picture/i],
  ['graph', /graph|plot|chart|axis/i],
  ['table', /table|grid|matrix|\brow\b|\bcell\b/i],
  ['equation', /equation|formula|\bmath\b|expression|superscript|subscript/i],
  ['chemical', /chem|benzene|molecul|\bbond\b|reaction/i],
  ['headerFooter', /header|footer|page\s*(no|number)|running\s*head|watermark/i],
  ['border', /border|\bedge\b|margin|frame|divider|separator|rule\s*line/i],
  ['background', /background|\bbg\b|shading|noise|cleanup/i],
  ['detached', /detach|orphan|isolated|stranded/i],
  ['incomplete', /incomplete|missing|truncat|\bcut\b|clipped|partial/i],
  ['option', /option|choice|\bmcq\b|answer\s*key/i],
];
const EMPTY_CATS = () => Object.fromEntries([...CATEGORY_RULES.map(([k]) => [k, 0]), ['uncategorized', 0]]);
const classify = (reason, cats, uncats) => {
  const r = String(reason ?? '').trim();
  let matched = false;
  for (const [key, rx] of CATEGORY_RULES) if (rx.test(r)) { cats[key] += 1; matched = true; }
  if (!matched) { cats.uncategorized += 1; uncats.push(r || '(empty reason)'); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ipv4 = (u) => u.replace('://localhost', '://127.0.0.1');
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

const fetchAllDrafts = async (jobId, A, total) => {
  const out = [];
  for (let off = 0; ; off += DRAFT_PAGE) {
    const body = await (await ff(`${API}/ocr/jobs/${jobId}/drafts?limit=${DRAFT_PAGE}&offset=${off}`, { headers: A })).json();
    const page = body.data ?? [];
    out.push(...page);
    if (page.length < DRAFT_PAGE) break;
    if (total != null && out.length >= total) break;
    if (off > 20000) break; // backstop
  }
  return out;
};

const run = async (token, pdfPath) => {
  const name = basename(pdfPath);
  const bytes = readFileSync(pdfPath);
  const A = (t) => ({ Authorization: `Bearer ${t}` });
  const t0 = Date.now();
  const signed = await j(ff(`${API}/uploads`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...A(token) },
    body: JSON.stringify({ originalName: name, mimeType: 'application/pdf', sizeBytes: statSync(pdfPath).size, category: 'ocr-papers' }),
  }));
  const putRes = await ff(signed.signedUrl, {
    method: signed.httpMethod, headers: { 'content-type': 'application/pdf', ...(signed.requiredHeaders ?? {}) }, body: bytes,
  });
  if (!putRes.ok) throw new Error(`byte upload HTTP ${putRes.status}`);
  await j(ff(`${API}/uploads/${signed.id}/complete`, { method: 'POST', headers: A(token) }));

  const deadline = Date.now() + 14 * 60_000;
  let stage = '';
  while (Date.now() < deadline) {
    const s = await j(ff(`${API}/ocr/progress/${signed.id}`, { headers: A(token) }));
    stage = s.ocrStage;
    process.stdout.write(`\r  ${name}: ${stage} ${s.pageProcessed ?? '?'}/${s.pageTotal ?? '?'} (${s.progressPercent ?? 0}%)        `);
    if (stage === 'FAILED' || s.uploadStatus === 'FAILED') throw new Error(`OCR FAILED: ${s.errorMessage}`);
    if (stage === 'COMPLETED') break;
    await sleep(3000);
  }
  if (stage !== 'COMPLETED') throw new Error(`timeout after ${Math.round((Date.now() - t0) / 1000)}s (last stage=${stage})`);
  process.stdout.write('\n');

  const detail = await j(ff(`${API}/uploads/${signed.id}`, { headers: A(token) }));
  const jobId = detail.ocrJob?.id;
  const job = await j(ff(`${API}/ocr/jobs/${jobId}`, { headers: A(token) }));
  const dc = job.draftCounts ?? {};
  const persisted = (dc.PENDING_REVIEW ?? 0) + (dc.EDITED ?? 0) + (dc.APPROVED ?? 0) + (dc.DISCARDED ?? 0);
  const draftsRaw = await fetchAllDrafts(jobId, A(token), persisted);
  const drafts = draftsRaw.map((d) => ({
    questionNumber: d.questionNumber ?? null, optionCount: d.optionCount ?? null,
    snapshot: d.questionSnapshotKey ?? null, review: !!d.needsImageReview, invalid: !!d.invalidCrop,
    pythonBuilt: !!d.pythonBuilt, type: d.detectedType ?? null,
  }));
  const authority = await j(ff(`${API}/ocr/jobs/${jobId}/authority`, { headers: A(token) })).catch(() => null);
  return { name, jobId, drafts, persisted, draftCounts: dc, authority, elapsedS: Math.round((Date.now() - t0) / 1000) };
};

const evaluate = (rec) => {
  const { name, drafts, persisted, authority, elapsedS } = rec;
  const a = (authority && Object.keys(authority).length) ? authority : null;
  const nums = drafts.map((d) => d.questionNumber).filter((n) => typeof n === 'number');
  const seen = new Map(); nums.forEach((n) => seen.set(n, (seen.get(n) ?? 0) + 1));
  const dupCount = [...seen.values()].filter((c) => c > 1).length;
  const q0 = nums.filter((n) => n === 0).length;
  const neg = nums.filter((n) => n < 0).length;
  let impossible = 0; for (let i = 1; i < nums.length; i++) if (nums[i] < nums[i - 1]) impossible++;
  const pos = nums.filter((n) => n > 0); const maxN = pos.length ? Math.max(...pos) : 0;
  const present = new Set(pos);
  const skipped = maxN ? Array.from({ length: maxN }, (_, i) => i + 1).filter((n) => !present.has(n)) : [];
  const cropCount = drafts.filter((d) => d.snapshot).length;
  const reviewCount = drafts.filter((d) => d.review || d.invalid).length;
  const pyBuilt = drafts.filter((d) => d.pythonBuilt).length;
  const expected = EXPECTED[name] ?? null;

  const cats = EMPTY_CATS(); const uncats = [];
  let chain = null, nncFull = null;
  if (a) {
    chain = [a.pyLogical, a.pyOwnership, a.pyComplete, a.pyCrops, a.pyDelivered, a.tsStored];
    nncFull = chain.every((n) => n === chain[0]);
    for (const rj of (a.rejected ?? [])) classify(rj.reason, cats, uncats);
  }

  const deliver = a?.deliver === true;
  const interceptedProof = a?.intercepted === true;
  // independent persist cross-check: in deliver mode the PERSISTED count must equal Python's logical
  // count; any drift means TS reshaped the set during persist (real interception the proof might miss).
  const persistDrift = deliver && a && persisted !== a.pyLogical;

  // ── classify outcome + collect golden-rule violations ──
  const fail = [];
  let outcome;
  if (!a) { outcome = 'NO_PROOF'; fail.push('NO AUTHORITY PROOF (build mode did not engage — delivery unprovable)'); }
  else if (interceptedProof) { outcome = 'FAIL'; fail.push('TS INTERCEPTED Python (authority.intercepted=true)'); }
  else if (persistDrift) { outcome = 'FAIL'; fail.push(`PERSIST DRIFT: Python delivered ${a.pyLogical} but TS stored ${persisted}`); }
  else if (deliver) {
    outcome = 'DELIVERED';
    // a delivered set MUST be internally clean — anything broken here is a SILENT WRONG DELIVERY
    if (!nncFull) fail.push(`N=N=C broken in delivered set: ${chain.join('=')}`);
    if (dupCount) fail.push(`${dupCount} duplicate question number(s) DELIVERED`);
    if (q0) fail.push(`${q0} question-zero DELIVERED`);
    if (neg) fail.push(`${neg} negative number(s) DELIVERED`);
    if (impossible) fail.push(`${impossible} out-of-order sequence(s) DELIVERED`);
    if (cropCount < persisted) fail.push(`${persisted - cropCount} DELIVERED draft(s) without a crop`);
    if (pyBuilt < persisted) fail.push(`${persisted - pyBuilt} DELIVERED draft(s) not marked pythonBuilt`);
    if (expected != null && persisted !== expected) fail.push(`DELIVERED ${persisted} ≠ expected ${expected}`);
    if (fail.length) outcome = 'FAIL';
  } else {
    outcome = 'WITHHELD'; // deliver=false, intercepted=false → routed to review (safety net OK)
  }

  return {
    name, elapsedS, expected, authority: a, outcome, fail, uncats, cats,
    persisted, cropCount, reviewCount, pyBuilt,
    dupCount, q0, neg, impossible, skipped, nncFull, chain,
    deliver, intercepted: interceptedProof, persistDrift,
    recovered: a?.recovered ?? [], missing: a?.missing ?? [], dupes: a?.duplicates ?? [],
    qZero: !!a?.questionZero, rejected: a?.rejected ?? [], stage1: a?.stage1, stage2: a?.stage2,
    seq: nums,
  };
};

const fmtList = (x, n = 12) => (x?.length ? (x.slice(0, n).join(',') + (x.length > n ? `…(+${x.length - n})` : '')) : '—');

const printReport = (e) => {
  const a = e.authority;
  const chain = a ? `${a.pyLogical}=${a.pyOwnership}=${a.pyComplete}=${a.pyCrops}=${a.pyDelivered}=${a.tsStored}` : 'NO PROOF';
  const stage2 = e.deliver ? (e.stage2 ?? '—') : `WITHHELD (${e.stage2 ?? 'not reached'})`;
  console.log(`
${'═'.repeat(72)}
PDF Name:                  ${e.name}   (${e.elapsedS}s)   OUTCOME: ${e.outcome}
Expected Questions:        ${e.expected ?? '— (unknown; judged by internal consistency)'}
[authority] pyLogical=pyOwnership=pyComplete=pyCrops=pyDelivered=tsStored
                           ${chain}
  Python Logical Count:    ${a?.pyLogical ?? '—'}
  Python Ownership Count:  ${a?.pyOwnership ?? '—'}
  Python Complete Count:   ${a?.pyComplete ?? '—'}
  Python Crop Count:       ${a?.pyCrops ?? '—'}
  Python Delivered Count:  ${a?.pyDelivered ?? '—'}
  TS Stored (persisted):   ${e.persisted}   (pythonBuilt ${e.pyBuilt}/${e.persisted}, crops ${e.cropCount})
  deliver:                 ${e.deliver}
  intercepted:             ${e.intercepted}${e.intercepted ? '  ◄── FAIL' : ''}${e.persistDrift ? '   persistDrift ◄── FAIL' : ''}
N=N=C (recomputed equal):  ${e.nncFull === null ? '—' : (e.nncFull ? 'PASS' : (e.deliver ? 'FAIL' : 'n/a — nothing delivered'))}
Stage 1 N=N=C:             ${e.stage1 === undefined ? '—' : (e.stage1 ? 'PASS' : 'FAIL (logical≠complete; questions incomplete)')}
Stage 2 N=N=C:             ${stage2}
Recovered Questions:       ${fmtList(e.recovered)}
Missing Questions:         ${fmtList(e.missing)}
Duplicates:                ${e.dupCount} ${fmtList(e.dupes)}
Question 0:                ${e.q0 || (e.qZero ? 'true' : 0)}
Impossible Sequences:      ${e.impossible}
Skipped Numbers:           ${fmtList(e.skipped)}
Cross-page Issues:         ${e.cats.crossPage}
Cross-column Issues:       ${e.cats.crossColumn}
Diagram Issues:            ${e.cats.diagram}
Graph Issues:              ${e.cats.graph}
Table Issues:              ${e.cats.table}
Equation Issues:           ${e.cats.equation}
Chemical Structure Issues: ${e.cats.chemical}
Header/Footer Issues:      ${e.cats.headerFooter}
Border Issues:             ${e.cats.border}
Background Removal Issues:  ${e.cats.background}
Detached/Incomplete:       ${e.cats.detached + e.cats.incomplete}
Uncategorized rejections:  ${e.cats.uncategorized}${e.uncats.length ? '  → ' + fmtList([...new Set(e.uncats)], 8) : ''}
Routed to review:          ${e.reviewCount}/${e.persisted}
TS Intercepted:            ${e.intercepted ? 'YES ◄── FAIL' : 'no'}
${'─'.repeat(72)}`);
  if (e.rejected?.length) {
    console.log(`Rejected questions (${e.rejected.length}) — every rejection carries a reason:`);
    for (const r of e.rejected.slice(0, 50)) {
      console.log(`   Q${r.questionNumber ?? '?'}  own=${r.ownershipStatus} vis=${r.visualStatus} crop=${r.cropStatus} ` +
        `complete=${r.completeness} deliverable=${r.deliverable} :: ${r.reason}`);
    }
    if (e.rejected.length > 50) console.log(`   …(+${e.rejected.length - 50} more)`);
  }
  console.log(`VERDICT:                   ${e.outcome}${e.fail.length ? '  ◄── ' + e.fail.join(' | ') : ''}`);
};

const main = async () => {
  const args = process.argv.slice(2);
  const twice = args.includes('--twice');
  let files;
  if (args.includes('--suite')) files = [...REGRESSION, ...UNSEEN];
  else if (args.includes('--regression')) files = REGRESSION;
  else if (args.includes('--unseen')) files = UNSEEN;
  else if (args.includes('--determinism')) files = [...DETERMINISM];
  else files = args.filter((x) => !x.startsWith('--')).map((p) => basename(p));
  const explicitPaths = (!args.some((x) => ['--suite', '--regression', '--unseen', '--determinism'].includes(x)))
    ? args.filter((x) => !x.startsWith('--')) : null;
  const resolve = (n, i) => explicitPaths ? explicitPaths[i] : join(DL, n);

  if (!files.length) { console.error('No PDFs. Use --suite | --regression | --unseen | --determinism | <path>'); process.exit(2); }
  const token = await login();
  console.log(`logged in. API=${API}  |  ${files.length} PDF(s)\n`);

  const summary = [];
  for (let i = 0; i < files.length; i++) {
    const name = files[i];
    const path = resolve(name, i);
    if (!existsSync(path)) { console.log(`MISSING ON DISK: ${path}`); summary.push({ name, outcome: 'MISSING', fail: ['file not on disk'] }); continue; }
    const runTwice = twice || DETERMINISM.has(name);
    try {
      const e1 = evaluate(await run(token, path));
      printReport(e1);
      let determinism = '—';
      if (runTwice) {
        const e2 = evaluate(await run(token, path));
        const same = e1.persisted === e2.persisted && e1.outcome === e2.outcome &&
          (e1.authority?.pyLogical ?? -1) === (e2.authority?.pyLogical ?? -2) &&
          e1.deliver === e2.deliver && JSON.stringify(e1.seq) === JSON.stringify(e2.seq);
        determinism = same ? 'PASS' : 'FAIL';
        console.log(`Determinism:               ${determinism}  (run2 outcome=${e2.outcome} stored=${e2.persisted} logical=${e2.authority?.pyLogical ?? '—'})`);
        if (determinism === 'FAIL') { e1.fail.push('NON-DETERMINISTIC across two runs'); if (e1.outcome !== 'FAIL') e1.outcome = 'FAIL'; }
      }
      summary.push({ name, outcome: e1.outcome, determinism, delivered: e1.persisted, expected: e1.expected, deliver: e1.deliver, fail: e1.fail });
    } catch (err) {
      console.log(`\n✖ ERROR ${name}: ${err.message}`);
      summary.push({ name, outcome: 'ERROR', fail: [err.message] });
    }
  }

  console.log(`\n${'█'.repeat(72)}\nFINAL SUMMARY\n${'█'.repeat(72)}`);
  const icon = (o) => ({ DELIVERED: '✓', WITHHELD: '◐', FAIL: '✖', ERROR: '✖', MISSING: '∅', NO_PROOF: '✖' }[o] ?? '?');
  for (const s of summary) {
    console.log(`${icon(s.outcome)} ${String(s.outcome).padEnd(10)} ${s.name.padEnd(34)} stored=${s.delivered ?? '—'} exp=${s.expected ?? '—'} det=${s.determinism ?? '—'}`);
  }
  const delivered = summary.filter((s) => s.outcome === 'DELIVERED').length;
  const withheld = summary.filter((s) => s.outcome === 'WITHHELD').length;
  const failed = summary.filter((s) => ['FAIL', 'ERROR', 'NO_PROOF'].includes(s.outcome));
  console.log(`\nDELIVERED (auto): ${delivered}   WITHHELD→review: ${withheld}   FAIL/ERROR: ${failed.length}   of ${summary.length}`);
  console.log(`\nGOLDEN-RULE VIOLATIONS (the weaknesses): ${failed.length}`);
  for (const w of failed) for (const f of (w.fail ?? [])) console.log(`   ✖ ${w.name}: ${f}`);
  // Suite PASS = no golden-rule violation. WITHHELD does not fail the suite (safety net working).
  const suitePass = failed.length === 0;
  console.log(`\nSUITE (golden rules intact): ${suitePass ? 'PASS' : 'FAIL'}`);
  process.exit(suitePass ? 0 : 1);
};
main().catch((e) => { console.error(e); process.exit(1); });
