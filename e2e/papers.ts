/**
 * REGRESSION ACCEPTANCE CRITERIA + metric computation for the live OCR validation suite.
 *
 * These counts are HARD acceptance criteria, NOT improvement targets. A paper PASSES only when its
 * delivered count EXACTLY equals `expected` AND every failure category is zero AND every delivered
 * crop is valid. 178/180 is a FAIL. (User directive 2026-06-24.)
 *
 * The PDF binaries are NOT in the repo. Point the suite at a folder of the real papers via
 * REGRESSION_PDF_DIR; each paper is resolved by the first filename pattern that matches a file there.
 */
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

export interface PaperSpec {
  key: string;
  /** Human label shown in the report. */
  label: string;
  /** HARD expected delivered question count. */
  expected: number;
  /** Filename patterns (case-insensitive substrings); first match in REGRESSION_PDF_DIR wins. */
  patterns: string[];
}

export const PAPERS: PaperSpec[] = [
  { key: 'biology_cell', label: 'Biology_Cell', expected: 90, patterns: ['biology_cell', 'biology-cell', 'biologycell'] },
  { key: 'biology', label: 'Biology (85)', expected: 85, patterns: ['biology-85', 'biology_85', 'biology'] },
  { key: 'phyche', label: 'PHYCHE (50)', expected: 50, patterns: ['phyche'] },
  { key: '25rep', label: '25 REP @ sk (180)', expected: 180, patterns: ['25rep', '25 rep', '25-rep'] },
  { key: 'ad2601', label: 'AD 2601 Q (180)', expected: 180, patterns: ['ad2601', 'ad 2601', 'ad_2601', 'ad-2601'] },
  { key: 'aiots_dr09', label: 'AIOTS 1 & DR09 @ sk_0476 (180)', expected: 180, patterns: ['aiots', 'dr09', '0476'] },
];

/** Resolve a paper's PDF path inside REGRESSION_PDF_DIR by its filename patterns. Returns null if absent. */
export const resolvePdf = (dir: string, spec: PaperSpec): string | null => {
  if (!dir || !existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf'));
  for (const pat of spec.patterns) {
    const hit = files.find((f) => f.toLowerCase().includes(pat.toLowerCase()));
    if (hit) return join(dir, hit);
  }
  return null;
};

/** The subset of OcrDraft fields the suite reasons over (see GET /api/ocr/jobs/:id/drafts). */
export interface Draft {
  position: number;
  questionNumber: number | null;
  optionCount: number | null;
  questionSnapshotKey: string | null;
  invalidCrop: boolean | null;
  detectedType: string | null;
  status: string;
  sourceCoordinates?: { x0: number; y0: number; x1: number; y1: number; page?: number } | null;
  text?: string | null;
}

/** Every report field the user requires, plus the derived PASS/FAIL. */
export interface PaperReport {
  paper: string;
  expectedQuestions: number;
  logicalQuestions: number; // Python ownership logical count (authority) — null-safe
  ownershipCount: number | null;
  completeQuestions: number | null;
  cropCount: number; // delivered drafts that carry a crop image
  deliveredCount: number; // non-discarded drafts
  missingQuestions: number[];
  recoveredQuestions: number[] | null;
  duplicates: number[];
  questionZero: number;
  impossibleSequences: number;
  crossPageIssues: number | null;
  crossColumnIssues: number | null;
  diagramIssues: number | null;
  graphIssues: number | null;
  tableIssues: number | null;
  equationIssues: number | null;
  chemicalStructureIssues: number | null;
  headerFooterIssues: number | null;
  cropBoundaryIssues: number; // invalidCrop flags
  missingOptions: number; // MCQ below the paper's modal option count
  detachedOptions: number; // crops carrying options but no stem/number (orphan)
  unorderedCrops: number;
  deterministicPass: boolean | null;
  stage1NNC: boolean | null;
  stage2NNC: boolean | null;
  pass: boolean;
  failReasons: string[];
}

/**
 * Compute every metric from the delivered drafts (the authoritative delivered set) plus, when present,
 * the Python authority report (richer ownership/visual fields). Drafts alone determine the HARD
 * acceptance (count + crop validity + sequence integrity); authority adds the Python-internal counts.
 */
export const buildReport = (
  spec: PaperSpec,
  drafts: Draft[],
  authority: Record<string, any> | null,
  deterministicPass: boolean | null,
): PaperReport => {
  const delivered = drafts.filter((d) => d.status !== 'DISCARDED');
  const byPosition = [...delivered].sort((a, b) => a.position - b.position);
  const nums = delivered
    .map((d) => d.questionNumber)
    .filter((n): n is number => typeof n === 'number' && Number.isInteger(n));

  // duplicates
  const freq = new Map<number, number>();
  for (const n of nums) freq.set(n, (freq.get(n) ?? 0) + 1);
  const duplicates = [...freq.entries()].filter(([, c]) => c > 1).map(([n]) => n).sort((a, b) => a - b);

  // Question 0 / negatives (never a real question number)
  const questionZero = nums.filter((n) => n <= 0).length;

  // missing — gaps inside the contiguous positive range [min..max]; also enforce count == expected
  const pos = nums.filter((n) => n >= 1).sort((a, b) => a - b);
  const missingQuestions: number[] = [];
  if (pos.length) {
    const present = new Set(pos);
    for (let g = pos[0]; g <= pos[pos.length - 1]; g += 1) if (!present.has(g)) missingQuestions.push(g);
  }

  // impossible — a question number going BACKWARDS in delivered (position) order
  let impossible = 0;
  let lastNum = -Infinity;
  for (const d of byPosition) {
    const n = d.questionNumber;
    if (typeof n === 'number' && n >= 1) {
      if (n < lastNum) impossible += 1;
      lastNum = n;
    }
  }

  // unordered crops — same signal framed per the user's category
  const unorderedCrops = impossible;

  const cropCount = delivered.filter((d) => !!d.questionSnapshotKey).length;
  const cropBoundaryIssues = delivered.filter((d) => d.invalidCrop === true).length;

  // option completeness — paper-modal (value-free). MCQ below the dominant ≥4-option count = clipped (C/D missing).
  const optCounts = delivered.map((d) => d.optionCount ?? 0).filter((n) => n >= 2);
  let modal = 0;
  let modalFreq = 0;
  const ofreq = new Map<number, number>();
  for (const n of optCounts) ofreq.set(n, (ofreq.get(n) ?? 0) + 1);
  for (const [n, f] of ofreq) if (f > modalFreq || (f === modalFreq && n > modal)) { modal = n; modalFreq = f; }
  const enforceOptions = modal >= 4 && modalFreq >= optCounts.length * 0.6;
  const missingOptions = enforceOptions
    ? delivered.filter((d) => (d.optionCount ?? 0) >= 2 && (d.optionCount ?? 0) < modal).length
    : 0;
  // detached options — a crop that has an option block but no question number (orphan a/b/c/d)
  const detachedOptions = delivered.filter(
    (d) => (d.optionCount ?? 0) >= 2 && (d.questionNumber == null || (d.questionNumber as number) < 1),
  ).length;

  // Python authority (richer; null in analyze-only / hybrid mode unless wired through)
  const a = authority ?? null;
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const len = (v: unknown): number | null => (Array.isArray(v) ? v.length : null);
  const logicalQuestions = num(a?.pyLogical) ?? num(a?.logicalQuestionCount) ?? delivered.length;
  const ownershipCount = num(a?.pyOwnership) ?? num(a?.ownershipCount);
  const completeQuestions = num(a?.pyComplete) ?? num(a?.completeQuestionCount);
  const recoveredQuestions = Array.isArray(a?.recovered) ? (a!.recovered as number[]) : null;
  const stage1NNC = typeof a?.stage1 === 'boolean' ? (a!.stage1 as boolean) : null;
  const stage2NNC =
    typeof a?.stage2 === 'string' ? a!.stage2 === 'PASS' : typeof a?.stage2 === 'boolean' ? (a!.stage2 as boolean) : null;

  const failReasons: string[] = [];
  if (delivered.length !== spec.expected)
    failReasons.push(`deliveredCount ${delivered.length} ≠ expected ${spec.expected}`);
  if (cropCount !== delivered.length) failReasons.push(`${delivered.length - cropCount} delivered drafts have NO crop`);
  if (cropBoundaryIssues > 0) failReasons.push(`${cropBoundaryIssues} invalid crops`);
  if (duplicates.length) failReasons.push(`duplicates [${duplicates.join(',')}]`);
  if (questionZero) failReasons.push(`${questionZero} Question-0/negative`);
  if (missingQuestions.length) failReasons.push(`missing [${missingQuestions.join(',')}]`);
  if (impossible) failReasons.push(`${impossible} impossible/backwards sequence`);
  if (missingOptions) failReasons.push(`${missingOptions} questions below modal option count (${modal}) — C/D clipped`);
  if (detachedOptions) failReasons.push(`${detachedOptions} detached option blocks (orphan a/b/c/d)`);
  if (deterministicPass === false) failReasons.push('non-deterministic (two uploads differed)');

  return {
    paper: spec.label,
    expectedQuestions: spec.expected,
    logicalQuestions,
    ownershipCount,
    completeQuestions,
    cropCount,
    deliveredCount: delivered.length,
    missingQuestions,
    recoveredQuestions,
    duplicates,
    questionZero,
    impossibleSequences: impossible,
    crossPageIssues: len(a?.crossPage) ?? null,
    crossColumnIssues: len(a?.crossColumn) ?? null,
    diagramIssues: len(a?.diagramIssues) ?? null,
    graphIssues: len(a?.graphIssues) ?? null,
    tableIssues: len(a?.tableIssues) ?? null,
    equationIssues: len(a?.equationIssues) ?? null,
    chemicalStructureIssues: len(a?.chemicalIssues) ?? null,
    headerFooterIssues: len(a?.headerFooterIssues) ?? null,
    cropBoundaryIssues,
    missingOptions,
    detachedOptions,
    unorderedCrops,
    deterministicPass,
    stage1NNC,
    stage2NNC,
    pass: failReasons.length === 0,
    failReasons,
  };
};

/** A stable signature of a delivered set — used for the determinism check (same upload twice = identical). */
export const deliveredSignature = (drafts: Draft[]): string => {
  const sig = drafts
    .filter((d) => d.status !== 'DISCARDED')
    .map((d) => ({
      n: d.questionNumber ?? null,
      o: d.optionCount ?? null,
      c: !!d.questionSnapshotKey,
      i: d.invalidCrop === true,
    }))
    .sort((a, b) => (a.n ?? 1e9) - (b.n ?? 1e9) || (a.o ?? 0) - (b.o ?? 0));
  return JSON.stringify(sig);
};

/** Render a single paper's report as an aligned text block (printed to console + written to the JSON report). */
export const formatReport = (r: PaperReport): string => {
  const line = (k: string, v: unknown): string => `  ${k.padEnd(26)} ${v === null ? 'N/A' : v}`;
  return [
    `================ ${r.paper} ================`,
    line('Expected Questions', r.expectedQuestions),
    line('Logical Questions', r.logicalQuestions),
    line('Ownership Count', r.ownershipCount),
    line('Complete Questions', r.completeQuestions),
    line('Crop Count', r.cropCount),
    line('Delivered Count', r.deliveredCount),
    line('Missing Questions', `[${r.missingQuestions.join(',')}]`),
    line('Recovered Questions', r.recoveredQuestions ? `[${r.recoveredQuestions.join(',')}]` : null),
    line('Duplicates', `[${r.duplicates.join(',')}]`),
    line('Question 0', r.questionZero),
    line('Impossible Sequences', r.impossibleSequences),
    line('Cross-page Issues', r.crossPageIssues),
    line('Cross-column Issues', r.crossColumnIssues),
    line('Diagram Issues', r.diagramIssues),
    line('Graph Issues', r.graphIssues),
    line('Table Issues', r.tableIssues),
    line('Equation Issues', r.equationIssues),
    line('Chemical Structure Issues', r.chemicalStructureIssues),
    line('Header/Footer Issues', r.headerFooterIssues),
    line('Crop Boundary Issues', r.cropBoundaryIssues),
    line('Missing Options', r.missingOptions),
    line('Detached Options', r.detachedOptions),
    line('Unordered Crops', r.unorderedCrops),
    line('Deterministic PASS', r.deterministicPass),
    line('Stage 1 N=N=C', r.stage1NNC),
    line('Stage 2 N=N=C', r.stage2NNC),
    `  ${'RESULT'.padEnd(26)} ${r.pass ? 'PASS ✅' : 'FAIL ❌'}`,
    ...(r.failReasons.length ? [`  REASONS: ${r.failReasons.join(' | ')}`] : []),
  ].join('\n');
};
