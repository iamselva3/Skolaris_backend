import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { IObjectStorage, OBJECT_STORAGE } from '../../../shared/storage/object-storage.interface';
import { IOcrJobRepository, OCR_JOB_REPOSITORY } from '../repositories/ocr-job.repository';
import { IOcrDraftRepository, OCR_DRAFT_REPOSITORY } from '../repositories/ocr-draft.repository';
import { ANSWER_KEY_OCR, IAnswerKeyOcr } from '../ports/answer-key-ocr.port';
import { assignAnswersToDrafts, DraftRef, parseAnswerKey } from '../services/answer-key';

export interface ImportAnswerKeyInput {
  tenantId: string;
  ocrJobId: string;
  /** Pasted/typed answer-key text. Provide this OR `storageKey`. */
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

  async execute(input: ImportAnswerKeyInput): Promise<ImportAnswerKeyResult> {
    const text = input.text?.trim();
    if (!text && !input.storageKey) {
      throw new BadRequestException('Provide either `text` or `storageKey` for the answer key');
    }

    const job = await this.ocrJobs.findById(input.tenantId, input.ocrJobId);
    if (!job) throw new NotFoundException('OCR job not found');

    // Resolve the raw answer-key text: typed text wins; otherwise OCR the upload.
    let keyText = text ?? '';
    if (!keyText && input.storageKey) {
      const { body, contentType } = await this.storage.getObject(input.storageKey);
      keyText = await this.ocr.extractText(body, contentType);
    }

    const parsed = parseAnswerKey(keyText);
    if (parsed.entries.size === 0) {
      throw new BadRequestException(
        'No answer mappings could be read from the answer key (expected formats like "1-A 2-C").',
      );
    }

    const { data } = await this.drafts.list(input.tenantId, input.ocrJobId, MAX_DRAFTS, 0);
    const refs: DraftRef[] = data.map((d) => ({
      id: d.id,
      text: d.text,
      questionNumber: d.questionNumber,
      optionCount: d.optionCount,
    }));

    const report = assignAnswersToDrafts(refs, parsed);
    const matched = await this.drafts.setSuggestedAnswers(
      input.tenantId,
      report.assignments.map((a) => ({ id: a.draftId, suggestedAnswer: a.suggestedAnswer })),
    );

    return {
      matched,
      keyEntries: parsed.entries.size,
      unmatchedKeyNumbers: report.unmatchedKeyNumbers,
      unmatchedDrafts: report.unmatchedDraftIds.length,
      conflicts: parsed.conflicts,
      outOfRange: report.outOfRangeNumbers,
    };
  }
}
