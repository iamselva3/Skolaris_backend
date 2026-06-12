import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { IObjectStorage, OBJECT_STORAGE } from '../../../shared/storage/object-storage.interface';
import { IOcrJobRepository, OCR_JOB_REPOSITORY } from '../repositories/ocr-job.repository';
import { IOcrDraftRepository, OCR_DRAFT_REPOSITORY } from '../repositories/ocr-draft.repository';
import { ANSWER_KEY_OCR, IAnswerKeyOcr } from '../ports/answer-key-ocr.port';
import {
  assignAnswersToDrafts,
  buildParseReport,
  DraftRef,
  parseAnswerKey,
  ParseReport,
} from '../services/answer-key';

export interface ImportAnswerKeyInput {
  tenantId: string;
  ocrJobId: string;
  /** Pasted/typed/extracted answer-key text. Provide this OR `storageKey`. */
  text?: string;
  /** Storage key of an uploaded answer-key image/PDF to OCR. */
  storageKey?: string;
}

export interface ImportAnswerKeyResult {
  /** Drafts that received a pre-filled answer. */
  matched: number;
  /** Distinct answer entries parsed from the key. */
  keyEntries: number;
  /** Key question numbers that matched no draft. */
  unmatchedKeyNumbers: number[];
  /** Drafts left without a suggested answer (no number, or absent from key). */
  unmatchedDrafts: number;
  /** Key numbers dropped for conflicting duplicate answers. */
  conflicts: number[];
  /** Key numbers whose answer index exceeded the draft's option count. */
  outOfRange: number[];
  /** Full validation report (also drives the pre-import preview). */
  report: ParseReport;
}

export interface PreviewAnswerKeyResult {
  /** Full validation report: totals, missing, duplicates, conflicts, invalid,
   *  zero/negative, out-of-range, parsed list, and pages used/ignored. */
  report: ParseReport;
  /** How many parsed entries would map to a draft if applied (dry-run). */
  willMatch: number;
  /** Number of drafts in the job. */
  draftCount: number;
}

// NEET/JEE papers top out around 200 questions; one page is plenty.
const MAX_DRAFTS = 1000;

@Injectable()
export class ImportAnswerKeyUseCase {
  constructor(
    @Inject(OCR_DRAFT_REPOSITORY) private readonly drafts: IOcrDraftRepository,
    @Inject(OCR_JOB_REPOSITORY) private readonly ocrJobs: IOcrJobRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: IObjectStorage,
    @Inject(ANSWER_KEY_OCR) private readonly ocr: IAnswerKeyOcr,
  ) {}

  /**
   * Stateless parse + validate of raw key text (no job, no drafts, no I/O).
   * Used by the multi-file batch path to translate continuous numbering, so the
   * SAME canonical grammar is the single source of truth everywhere.
   */
  parse(text: string): ParseReport {
    return buildParseReport(text?.trim() ?? '');
  }

  /**
   * Dry-run: parse + validate + page-select and report, WITHOUT writing anything.
   * Powers the mandatory pre-import preview. Never throws on an empty/invalid key
   * — the report carries the issues for the UI to display.
   */
  async preview(input: ImportAnswerKeyInput): Promise<PreviewAnswerKeyResult> {
    const { keyText, pages } = await this.resolveKey(input);
    const refs = await this.loadDraftRefs(input.tenantId, input.ocrJobId);
    const { report, assignment } = this.buildReport(keyText, pages, refs);
    return { report, willMatch: assignment.assignments.length, draftCount: refs.length };
  }

  /**
   * Apply: parse + map onto drafts + persist suggested answers. Rejects an empty
   * key. Returns the same ParseReport as the preview so the UI summary is exact.
   */
  async execute(input: ImportAnswerKeyInput): Promise<ImportAnswerKeyResult> {
    const { keyText, pages } = await this.resolveKey(input);
    const parsed = parseAnswerKey(keyText);
    if (parsed.entries.size === 0) {
      throw new BadRequestException(
        'No answer mappings could be read from the answer key (expected formats like "1-A 2-C").',
      );
    }

    const refs = await this.loadDraftRefs(input.tenantId, input.ocrJobId);
    const { report, assignment } = this.buildReport(keyText, pages, refs);

    const matched = await this.drafts.setSuggestedAnswers(
      input.tenantId,
      assignment.assignments.map((a) => ({ id: a.draftId, suggestedAnswer: a.suggestedAnswer })),
    );

    return {
      matched,
      keyEntries: parsed.entries.size,
      unmatchedKeyNumbers: assignment.unmatchedKeyNumbers,
      unmatchedDrafts: assignment.unmatchedDraftIds.length,
      conflicts: parsed.conflicts,
      outOfRange: assignment.outOfRangeNumbers,
      report,
    };
  }

  /** Resolve raw answer-key text: typed text wins; otherwise OCR the upload via
   *  the ISOLATED answer-key OCR (keeps answer-key pages, drops solutions). */
  private async resolveKey(
    input: ImportAnswerKeyInput,
  ): Promise<{ keyText: string; pages: { used: number[]; ignored: Array<{ page: number; reason: string }> } }> {
    const text = input.text?.trim();
    if (!text && !input.storageKey) {
      throw new BadRequestException('Provide either `text` or `storageKey` for the answer key');
    }

    const job = await this.ocrJobs.findById(input.tenantId, input.ocrJobId);
    if (!job) throw new NotFoundException('OCR job not found');

    if (text) return { keyText: text, pages: { used: [], ignored: [] } };

    const { body, contentType } = await this.storage.getObject(input.storageKey as string);
    const ocr = await this.ocr.extractAnswerKey(body, contentType);
    return { keyText: ocr.text, pages: { used: ocr.pagesUsed, ignored: ocr.pagesIgnored } };
  }

  private async loadDraftRefs(tenantId: string, ocrJobId: string): Promise<DraftRef[]> {
    const { data } = await this.drafts.list(tenantId, ocrJobId, MAX_DRAFTS, 0);
    return data.map((d) => ({
      id: d.id,
      text: d.text,
      questionNumber: d.questionNumber,
      optionCount: d.optionCount,
      optionsLength: d.options?.length ?? null,
    }));
  }

  /** Parse → build the validation report → map onto drafts (for out-of-range). */
  private buildReport(
    keyText: string,
    pages: { used: number[]; ignored: Array<{ page: number; reason: string }> },
    refs: DraftRef[],
  ): { report: ParseReport; assignment: ReturnType<typeof assignAnswersToDrafts> } {
    const parsed = parseAnswerKey(keyText);
    const report = buildParseReport(keyText, pages);
    const assignment = assignAnswersToDrafts(refs, parsed);
    report.outOfRange = assignment.outOfRangeNumbers;
    return { report, assignment };
  }
}
