import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { ChapterModel } from '../models/taxonomy.models';
import {
  ITaxonomyRepository,
  TAXONOMY_REPOSITORY,
} from '../repositories/taxonomy.repository';

@Injectable()
export class ListChaptersUseCase {
  constructor(@Inject(TAXONOMY_REPOSITORY) private readonly repo: ITaxonomyRepository) {}
  execute(input: { tenantId: string; topicId?: string }): Promise<ChapterModel[]> {
    return this.repo.listChapters(input.tenantId, input.topicId);
  }
}

@Injectable()
export class GetChapterUseCase {
  constructor(@Inject(TAXONOMY_REPOSITORY) private readonly repo: ITaxonomyRepository) {}
  async execute(input: { tenantId: string; id: string }): Promise<ChapterModel> {
    const c = await this.repo.getChapter(input.tenantId, input.id);
    if (!c) throw new NotFoundException('Chapter not found');
    return c;
  }
}

@Injectable()
export class CreateChapterUseCase {
  constructor(@Inject(TAXONOMY_REPOSITORY) private readonly repo: ITaxonomyRepository) {}
  async execute(input: {
    tenantId: string;
    userId: string;
    role: Role;
    topicId: string;
    name: string;
    position?: number;
  }): Promise<ChapterModel> {
    const topic = await this.repo.getTopic(input.tenantId, input.topicId);
    if (!topic) throw new NotFoundException('Topic not found');

    if (input.role === Role.TEACHER) {
      const mine = await this.repo.listSubjectsForTeacher(input.tenantId, input.userId);
      if (!mine.some((s) => s.id === topic.subjectId)) {
        throw new ForbiddenException('Teachers may only add chapters under assigned subjects');
      }
    }

    try {
      return await this.repo.createChapter({
        tenantId: input.tenantId,
        topicId: input.topicId,
        name: input.name,
        position: input.position,
      });
    } catch (e: unknown) {
      if (isUniqueConstraintError(e)) {
        throw new ConflictException('A chapter with that name already exists for this topic');
      }
      throw e;
    }
  }
}

@Injectable()
export class UpdateChapterUseCase {
  constructor(@Inject(TAXONOMY_REPOSITORY) private readonly repo: ITaxonomyRepository) {}
  async execute(input: {
    tenantId: string;
    userId: string;
    role: Role;
    id: string;
    name?: string;
    position?: number;
  }): Promise<ChapterModel> {
    const existing = await this.repo.getChapter(input.tenantId, input.id);
    if (!existing) throw new NotFoundException('Chapter not found');

    if (input.role === Role.TEACHER) {
      const topic = await this.repo.getTopic(input.tenantId, existing.topicId);
      const mine = await this.repo.listSubjectsForTeacher(input.tenantId, input.userId);
      if (!topic || !mine.some((s) => s.id === topic.subjectId)) {
        throw new ForbiddenException('Teachers may only edit chapters under assigned subjects');
      }
    }

    return this.repo.updateChapter(input.tenantId, input.id, {
      name: input.name,
      position: input.position,
    });
  }
}

@Injectable()
export class DeleteChapterUseCase {
  constructor(@Inject(TAXONOMY_REPOSITORY) private readonly repo: ITaxonomyRepository) {}
  async execute(input: { tenantId: string; id: string }): Promise<void> {
    const existing = await this.repo.getChapter(input.tenantId, input.id);
    if (!existing) throw new NotFoundException('Chapter not found');
    await this.repo.deleteChapter(input.tenantId, input.id);
  }
}

function isUniqueConstraintError(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code: string }).code === 'P2002'
  );
}
