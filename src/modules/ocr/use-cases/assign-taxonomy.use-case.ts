import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Difficulty } from '../../questions/models/question-type.enum';
import { IOcrJobRepository, OCR_JOB_REPOSITORY } from '../repositories/ocr-job.repository';
import { IOcrDraftRepository, OCR_DRAFT_REPOSITORY } from '../repositories/ocr-draft.repository';
import { AssignedTaxonomy } from '../models/ocr-draft.model';

export interface AssignTaxonomyInput {
  tenantId: string;
  ocrJobId: string;
  /** Target drafts; omit/empty → apply to ALL drafts in the job. */
  draftIds?: string[];
  programId?: string;
  subjectId?: string;
  topicId?: string;
  chapterId?: string;
  difficulty?: Difficulty;
}

export interface AssignTaxonomyResult {
  /** Number of drafts updated. */
  updated: number;
  /** Whether the assignment targeted the whole job ("apply to all"). */
  appliedToAll: boolean;
}

/**
 * Bulk-assign Program/Subject/Chapter/Topic + difficulty across an OCR batch so
 * the teacher configures taxonomy once instead of per question. The assignment is
 * stored on the drafts and inherited by the approve flow as a default.
 */
@Injectable()
export class AssignTaxonomyUseCase {
  constructor(
    @Inject(OCR_DRAFT_REPOSITORY) private readonly drafts: IOcrDraftRepository,
    @Inject(OCR_JOB_REPOSITORY) private readonly ocrJobs: IOcrJobRepository,
  ) {}

  async execute(input: AssignTaxonomyInput): Promise<AssignTaxonomyResult> {
    const taxonomy: AssignedTaxonomy = {};
    if (input.programId !== undefined) taxonomy.programId = input.programId;
    if (input.subjectId !== undefined) taxonomy.subjectId = input.subjectId;
    if (input.topicId !== undefined) taxonomy.topicId = input.topicId;
    if (input.chapterId !== undefined) taxonomy.chapterId = input.chapterId;
    if (input.difficulty !== undefined) taxonomy.difficulty = input.difficulty;
    if (Object.keys(taxonomy).length === 0) {
      throw new BadRequestException('Provide at least one taxonomy field to assign');
    }

    const job = await this.ocrJobs.findById(input.tenantId, input.ocrJobId);
    if (!job) throw new NotFoundException('OCR job not found');

    const draftIds = input.draftIds && input.draftIds.length > 0 ? input.draftIds : null;
    const updated = await this.drafts.setTaxonomy(
      input.tenantId,
      input.ocrJobId,
      draftIds,
      taxonomy,
    );
    return { updated, appliedToAll: draftIds === null };
  }
}
