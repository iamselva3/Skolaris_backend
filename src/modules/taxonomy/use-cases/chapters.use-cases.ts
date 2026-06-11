import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { ChapterModel } from '../models/taxonomy.models';
import { ITaxonomyRepository, TAXONOMY_REPOSITORY } from '../repositories/taxonomy.repository';

@Injectable()
export class ListChaptersUseCase {
  constructor(@Inject(TAXONOMY_REPOSITORY) private readonly repo: ITaxonomyRepository) {}
  execute(input: { tenantId: string; subjectId?: string }): Promise<ChapterModel[]> {
    return this.repo.listChapters(input.tenantId, input.subjectId);
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
    subjectId: string;
    name: string;
    position?: number;
  }): Promise<ChapterModel> {
    const subject = await this.repo.getSubject(input.tenantId, input.subjectId);
    if (!subject) throw new NotFoundException('Subject not found');

    try {
      return await this.repo.createChapter({
        tenantId: input.tenantId,
        subjectId: input.subjectId,
        name: input.name,
        position: input.position,
      });
    } catch (e: unknown) {
      if (isUniqueConstraintError(e)) {
        throw new ConflictException('A chapter with that name already exists for this subject');
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
    typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'P2002'
  );
}
