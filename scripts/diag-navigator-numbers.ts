/* eslint-disable no-console */
/**
 * READ-ONLY ownership trace for the Question Navigator numbers.
 *
 * Reproduces EXACTLY what the FE navigator renders for a given OCR job, straight
 * from the PERSISTED OcrDraft rows — no re-OCR, no mutation. It mirrors the FE
 * `draftQuestionNumber(d) = d.questionNumber ?? parseDraftNumber(d.text)` so the
 * printed sequence is byte-identical to the tiles on screen, then attributes the
 * source of every number:
 *
 *   PERSISTED      → row.questionNumber was non-null (born upstream: TS engine
 *                    segmentation / TS analysis delivery / Python engine)
 *   TEXT_FALLBACK  → row.questionNumber was NULL and the FE regex parsed a
 *                    leading "N." / "N)" / "Q.N" out of the crop text (UI-born)
 *
 * It then runs the three assertions the bug requires and prints the final
 * ownership report identifying the EXACT stage that created a duplicate.
 *
 *   npx ts-node --transpile-only scripts/diag-navigator-numbers.ts            # most recent job w/ drafts
 *   npx ts-node --transpile-only scripts/diag-navigator-numbers.ts <ocrJobId>
 *   npx ts-node --transpile-only scripts/diag-navigator-numbers.ts <originalName-substring>
 */
import { PrismaClient } from '@prisma/client';

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config();
} catch {
  /* env assumed pre-populated */
}

// ── VERBATIM copy of FE src/lib/ocr/question-number.ts parseDraftNumber ──
const parseDraftNumber = (text: string | null | undefined): number | null => {
  const t = (text ?? '').trimStart();
  let m = /^(?:Q(?:uestion)?\.?\s*)?(\d{1,3})\s*[.):]/.exec(t);
  if (m) return Number(m[1]);
  m = /^(\d{2,3})(?=[A-Za-z])/.exec(t);
  return m ? Number(m[1]) : null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const arg = (process.argv[2] ?? '').trim();
  try {
    // ── Resolve the OcrJob ──
    let jobId: string | null = null;
    if (arg && UUID.test(arg)) {
      // Could be an ocrJobId or an uploadId.
      const asJob = await prisma.ocrJob.findUnique({ where: { id: arg } });
      if (asJob) jobId = asJob.id;
      else {
        const asUpJob = await prisma.ocrJob.findUnique({ where: { uploadId: arg } });
        if (asUpJob) jobId = asUpJob.id;
      }
    } else if (arg) {
      const up = await prisma.upload.findFirst({
        where: { originalName: { contains: arg, mode: 'insensitive' } },
        orderBy: { updatedAt: 'desc' },
      });
      if (up) {
        const j = await prisma.ocrJob.findUnique({ where: { uploadId: up.id } });
        jobId = j?.id ?? null;
      }
    }
    if (!jobId) {
      // Default: the most recently updated job that actually has drafts.
      const recent = await prisma.ocrDraft.findFirst({
        orderBy: { updatedAt: 'desc' },
        select: { ocrJobId: true },
      });
      jobId = recent?.ocrJobId ?? null;
    }
    if (!jobId) {
      console.log('No OcrJob with drafts found.');
      return;
    }

    const job = await prisma.ocrJob.findUnique({ where: { id: jobId } });
    const upload = job ? await prisma.upload.findUnique({ where: { id: job.uploadId } }) : null;

    // ── The drafts EXACTLY as the FE single-upload path reads them: ──
    // GET /ocr/jobs/:id/drafts → repository.list → orderBy position asc.
    const rows = await prisma.ocrDraft.findMany({
      where: { ocrJobId: jobId },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        position: true,
        questionNumber: true,
        invalidCrop: true,
        detectedType: true,
        status: true,
        text: true,
      },
    });

    console.log('═'.repeat(78));
    console.log(`OCR JOB        : ${jobId}`);
    console.log(`upload         : ${upload?.originalName ?? '?'}  [${job?.uploadId}]`);
    console.log(`providerUsed   : ${job?.providerUsed ?? '?'}   (← who authored the drafts)`);
    console.log(`persisted rows : ${rows.length}`);
    console.log('═'.repeat(78));

    // ── Authority (Python build mode) if present, so we can name Python's own count chain. ──
    const raw = (job?.rawOutput ?? null) as { authority?: Record<string, unknown> } | null;
    const authority = raw?.authority ?? null;
    if (authority) {
      console.log('PYTHON AUTHORITY (OcrJob.rawOutput.authority):');
      for (const k of ['pyLogical', 'pyOwnership', 'pyComplete', 'pyCrops', 'delivered', 'tsStored', 'intercepted']) {
        if (k in authority) console.log(`   ${k.padEnd(12)} = ${JSON.stringify((authority as any)[k])}`);
      }
    } else {
      console.log('PYTHON AUTHORITY: none (legacy/TS path — drafts authored by the TS engine/delivery).');
    }
    console.log('─'.repeat(78));

    // ── Per-draft trace: reproduce the FE navigator number + its source. ──
    type Tile = {
      pos: number;
      persisted: number | null;
      fallback: number | null;
      shown: number | null;
      source: 'PERSISTED' | 'TEXT_FALLBACK' | 'UNNUMBERED';
      invalidCrop: boolean | null;
      type: string | null;
      textHead: string;
    };
    const tiles: Tile[] = rows.map((r) => {
      const persisted = r.questionNumber ?? null;
      const fallback = parseDraftNumber(r.text);
      const shown = persisted ?? fallback;
      const source: Tile['source'] =
        persisted != null ? 'PERSISTED' : shown != null ? 'TEXT_FALLBACK' : 'UNNUMBERED';
      return {
        pos: r.position,
        persisted,
        fallback,
        shown,
        source,
        invalidCrop: r.invalidCrop,
        type: r.detectedType,
        textHead: (r.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 44),
      };
    });

    // ── The exact rendered navigator sequence. ──
    const navSeq = tiles.map((t) => (t.shown != null ? String(t.shown) : '—'));
    console.log('ui.navigatorNumbers[] (position order — EXACTLY the on-screen tiles):');
    console.log(`   ${navSeq.join(' ')}`);
    console.log('─'.repeat(78));

    const persistedSeq = tiles.map((t) => t.persisted).filter((n): n is number => n != null);
    console.log(`ts.persistedQuestionNumbers[] (non-null only): ${persistedSeq.join(' ')}`);
    console.log('─'.repeat(78));

    // ── Duplicate detection on the SHOWN numbers (what the user sees). ──
    const shownNums = tiles.map((t) => t.shown).filter((n): n is number => n != null);
    const countBy = new Map<number, Tile[]>();
    for (const t of tiles) if (t.shown != null) (countBy.get(t.shown) ?? countBy.set(t.shown, []).get(t.shown)!).push(t);
    const dups = [...countBy.entries()].filter(([, v]) => v.length > 1).sort((a, b) => a[0] - b[0]);

    console.log('DUPLICATE TILES (shown number appears on >1 draft):');
    if (dups.length === 0) console.log('   none');
    for (const [n, insts] of dups) {
      console.log(`   ▸ "${n}" ×${insts.length}`);
      for (const it of insts) {
        console.log(
          `       pos=${String(it.pos).padStart(3)} source=${it.source.padEnd(13)} ` +
            `persisted=${String(it.persisted).padEnd(5)} textFallback=${String(it.fallback).padEnd(5)} ` +
            `invalidCrop=${it.invalidCrop} type=${it.type}`,
        );
        console.log(`           text="${it.textHead}"`);
      }
    }
    console.log('─'.repeat(78));

    // ── Assertions ──
    const uniqShown = new Set(shownNums).size === shownNums.length;
    const maxShown = shownNums.length ? Math.max(...shownNums) : 0;
    const fullRange = (() => {
      const s = new Set(shownNums);
      for (let i = 1; i <= maxShown; i += 1) if (!s.has(i)) return false;
      return s.size === maxShown; // 1..N, no gaps, no dups
    })();
    const navCount = tiles.length;
    const persistedCount = rows.length;

    console.log('ASSERTIONS:');
    console.log(`   no duplicate shown numbers          : ${uniqShown ? 'PASS' : 'FAIL'}`);
    console.log(`   sequence is a clean 1..N            : ${fullRange ? 'PASS' : 'FAIL'} (max=${maxShown}, distinct=${new Set(shownNums).size})`);
    console.log(`   navigatorCount == persistedCount    : ${navCount === persistedCount ? 'PASS' : 'FAIL'} (${navCount} vs ${persistedCount})`);
    console.log('─'.repeat(78));

    // ── Final ownership verdict. ──
    // Who AUTHORED the drafts is providerUsed, NOT the presence of an authority blob.
    // A Python authority can be ADVISORY (analyze mode: pyCrops=0, intercepted=false) while
    // the TS Tesseract engine actually authored + numbered the persisted drafts. In that case a
    // pyLogical < tsStored gap is Python CORRECTLY counting fewer questions than TS minted.
    const provider = job?.providerUsed ?? '';
    const tsAuthored = /tesseract|paddle|vision|pdfjs/i.test(provider) && !/python-engine/i.test(provider);
    const pyAdvisoryButCorrect =
      authority &&
      tsAuthored &&
      Number((authority as any).pyLogical) > 0 &&
      Number((authority as any).pyLogical) < Number((authority as any).tsStored);
    const dupFromPersisted = dups.some(([, v]) => v.every((t) => t.source === 'PERSISTED'));
    const dupFromFallback = dups.some(([, v]) => v.some((t) => t.source === 'TEXT_FALLBACK'));
    console.log('FINAL OWNERSHIP REPORT');
    console.log(`   Stage                : ${tsAuthored ? `TS engine (${provider}) segmentation → TS persistence` : 'Python engine → TS persistence'}`);
    if (pyAdvisoryButCorrect) {
      console.log(`   Python role          : ADVISORY ONLY — counted pyLogical=${(authority as any).pyLogical} (correct, no dup) vs tsStored=${(authority as any).tsStored}; not enforced (intercepted=${(authority as any).intercepted}).`);
    }
    console.log(`   Question Count       : ${tiles.length}`);
    console.log(`   Duplicates           : ${dups.length}`);
    console.log(`   Impossible Sequence  : ${fullRange ? 'no' : 'YES'}`);
    if (dups.length === 0) {
      console.log('   OWNER                : (no duplicate present in this job)');
    } else if (dupFromPersisted && !dupFromFallback) {
      console.log('   OWNER                : UPSTREAM — duplicate is in the PERSISTED questionNumber.');
      console.log(`                          → born in ${tsAuthored ? `TS engine segmentVisualDrafts (${provider})` : 'PYTHON engine ownership/numbering'}, stored verbatim.`);
      if (pyAdvisoryButCorrect) console.log('                          → Python ownership had the CORRECT count but was advisory, so it did not intercept.');
    } else if (dupFromFallback && !dupFromPersisted) {
      console.log('   OWNER                : UI TEXT FALLBACK — the duplicate row(s) persisted questionNumber=NULL;');
      console.log('                          the FE parseDraftNumber() manufactured the number from the crop text.');
      console.log('                          (bug lives in question-number.ts fallback, NOT in persistence.)');
    } else {
      console.log('   OWNER                : MIXED — see per-duplicate source above.');
    }
    console.log('═'.repeat(78));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
