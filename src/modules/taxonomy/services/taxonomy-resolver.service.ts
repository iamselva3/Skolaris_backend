import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ChapterModel, ProgramModel, SubjectModel, TopicModel } from '../models/taxonomy.models';
import { ITaxonomyRepository, TAXONOMY_REPOSITORY } from '../repositories/taxonomy.repository';

export interface TaxonomySelection {
  programId?: string | null;
  subjectId?: string | null;
  topicId?: string | null;
  chapterId?: string | null;
}

export interface ResolvedTaxonomy {
  program: ProgramModel | null;
  subject: SubjectModel | null;
  topic: TopicModel | null;
  chapter: ChapterModel | null;
}

/**
 * Validates a taxonomy selection against the tenant and enforces the chain:
 * subject ∈ program, chapter ∈ subject, topic ∈ chapter. Throws 400 on any
 * mismatch. `null`/`undefined` levels are skipped; partial selections are
 * permitted (e.g. only programId+subjectId for an upload pre-tag).
 *
 * Used by uploads / questions / exams to enforce taxonomy consistency at
 * write time and to fetch the resolved entities (callers use `subject.name`,
 * `chapter.name` and `topic.name` to denormalize for analytics).
 */
@Injectable()
export class TaxonomyResolverService {
  constructor(@Inject(TAXONOMY_REPOSITORY) private readonly repo: ITaxonomyRepository) {}

  async resolve(tenantId: string, sel: TaxonomySelection): Promise<ResolvedTaxonomy> {
    const out: ResolvedTaxonomy = { program: null, subject: null, topic: null, chapter: null };

    if (sel.programId) {
      out.program = await this.repo.getProgram(tenantId, sel.programId);
      if (!out.program) throw new BadRequestException('programId is invalid for this tenant');
    }

    if (sel.subjectId) {
      out.subject = await this.repo.getSubject(tenantId, sel.subjectId);
      if (!out.subject) throw new BadRequestException('subjectId is invalid for this tenant');
      if (out.program && out.subject.programId !== out.program.id) {
        throw new BadRequestException('subjectId does not belong to the supplied programId');
      }
    }

    if (sel.chapterId) {
      out.chapter = await this.repo.getChapter(tenantId, sel.chapterId);
      if (!out.chapter) throw new BadRequestException('chapterId is invalid for this tenant');
      if (out.subject && out.chapter.subjectId !== out.subject.id) {
        throw new BadRequestException('chapterId does not belong to the supplied subjectId');
      }
    }

    if (sel.topicId) {
      out.topic = await this.repo.getTopic(tenantId, sel.topicId);
      if (!out.topic) throw new BadRequestException('topicId is invalid for this tenant');
      if (out.chapter && out.topic.chapterId !== out.chapter.id) {
        throw new BadRequestException('topicId does not belong to the supplied chapterId');
      }
    }

    return out;
  }
}
