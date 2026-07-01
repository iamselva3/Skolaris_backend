/* eslint-disable no-console */
/**
 * READ-ONLY runtime trace of the Python-engine execution path. Resolves the gate
 * decisions by calling the SAME functions the production runner/delivery call
 * (not by reading raw env), then dumps the persisted authority blob of a job so
 * we can see exactly where /build-document stopped.
 *
 *   npx ts-node --transpile-only scripts/diag-python-engine-path.ts [ocrJobId]
 */
import { PrismaClient } from '@prisma/client';
import { isPythonDocumentEngineEnabled } from '../src/shared/workers/ocr-job-runner.service';
import {
  readStructureBuildSettings,
  readStructureAnalyzeSettings,
} from '../src/shared/ocr-engine/structure-analyze-http';
import { readStructureSettings } from '../src/shared/ocr-engine/structure-http';

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config();
} catch {
  /* env assumed pre-populated */
}

async function main(): Promise<void> {
  console.log('═'.repeat(78));
  console.log('RUNTIME GATE DECISIONS (resolved via the real production gate functions)');
  console.log('═'.repeat(78));
  const docEngine = isPythonDocumentEngineEnabled();
  const build = readStructureBuildSettings();
  const analyze = readStructureAnalyzeSettings();
  const validate = readStructureSettings();
  console.log(`PYTHON_DOCUMENT_ENGINE (whole-upload /process-document via runPythonDocumentEngine)`);
  console.log(`   isPythonDocumentEngineEnabled() = ${docEngine}`);
  console.log(`STRUCTURE_BUILD_ENABLED (/build-document via delivery.buildPythonCrops)`);
  console.log(`   readStructureBuildSettings().enabled    = ${build.enabled}`);
  console.log(`   readStructureBuildSettings().serviceUrl = ${build.serviceUrl ?? 'NULL'}`);
  console.log(`STRUCTURE_ANALYZE_ENABLED (advisory /analyze-document via applyStructuralProposal)`);
  console.log(`   readStructureAnalyzeSettings().enabled    = ${analyze.enabled}`);
  console.log(`   readStructureAnalyzeSettings().serviceUrl = ${analyze.serviceUrl ?? 'NULL'}`);
  console.log(`STRUCTURE_VALIDATOR_ENABLED (/validate-structure per-crop)`);
  console.log(`   readStructureSettings().enabled    = ${validate.enabled}`);
  console.log(`   readStructureSettings().serviceUrl = ${validate.serviceUrl ?? 'NULL'}`);
  console.log('─'.repeat(78));
  console.log('Static path implication:');
  console.log(`   runPythonDocumentEngine() will ${docEngine ? 'RUN (gate ON)' : 'RETURN FALSE immediately (gate OFF) → TS OCR runs'}`);
  console.log(`   delivery.buildPythonCrops() will ${build.enabled && build.serviceUrl ? 'CALL POST /build-document' : 'SKIP (handled:false) → advisory analyze path'}`);
  console.log('═'.repeat(78));

  const prisma = new PrismaClient();
  try {
    const arg = (process.argv[2] ?? '').trim();
    let jobId = arg;
    if (!jobId) {
      const recent = await prisma.ocrDraft.findFirst({
        orderBy: { updatedAt: 'desc' },
        select: { ocrJobId: true },
      });
      jobId = recent?.ocrJobId ?? '';
    }
    if (!jobId) {
      console.log('No job to inspect.');
      return;
    }
    const job = await prisma.ocrJob.findUnique({ where: { id: jobId } });
    const persisted = await prisma.ocrDraft.count({ where: { ocrJobId: jobId } });
    const raw = (job?.rawOutput ?? null) as { authority?: Record<string, unknown> } | null;
    console.log(`JOB ${jobId}`);
    console.log(`   providerUsed       = ${job?.providerUsed ?? '?'}`);
    console.log(`   persisted drafts   = ${persisted}`);
    console.log('─'.repeat(78));
    if (!raw?.authority) {
      console.log('PERSISTED AUTHORITY: none → buildPythonCrops did NOT run as authoritative on this job.');
    } else {
      console.log('PERSISTED AUTHORITY (OcrJob.rawOutput.authority) — the last run\'s Python build verdict:');
      console.log(JSON.stringify(raw.authority, null, 2));
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
