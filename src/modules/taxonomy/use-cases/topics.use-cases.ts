import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { TopicModel } from '../models/taxonomy.models';
import { ITaxonomyRepository, TAXONOMY_REPOSITORY } from '../repositories/taxonomy.repository';

@Injectable()
export class ListTopicsUseCase {
  constructor(@Inject(TAXONOMY_REPOSITORY) private readonly repo: ITaxonomyRepository) {}
  execute(input: { tenantId: string; chapterId?: string }): Promise<TopicModel[]> {
    return this.repo.listTopics(input.tenantId, input.chapterId);
  }
}

@Injectable()
export class GetTopicUseCase {
  constructor(@Inject(TAXONOMY_REPOSITORY) private readonly repo: ITaxonomyRepository) {}
  async execute(input: { tenantId: string; id: string }): Promise<TopicModel> {
    const t = await this.repo.getTopic(input.tenantId, input.id);
    if (!t) throw new NotFoundException('Topic not found');
    return t;
  }
}

@Injectable()
export class CreateTopicUseCase {
  constructor(@Inject(TAXONOMY_REPOSITORY) private readonly repo: ITaxonomyRepository) {}
  async execute(input: {
    tenantId: string;
    userId: string;
    role: Role;
    chapterId: string;
    name: string;
    position?: number;
  }): Promise<TopicModel> {
    const chapter = await this.repo.getChapter(input.tenantId, input.chapterId);
    if (!chapter) throw new NotFoundException('Chapter not found');

    try {
      return await this.repo.createTopic({
        tenantId: input.tenantId,
        chapterId: input.chapterId,
        name: input.name,
        position: input.position,
      });
    } catch (e: unknown) {
      if (isUniqueConstraintError(e)) {
        throw new ConflictException('A topic with that name already exists for this chapter');
      }
      throw e;
    }
  }
}

@Injectable()
export class UpdateTopicUseCase {
  constructor(@Inject(TAXONOMY_REPOSITORY) private readonly repo: ITaxonomyRepository) {}
  async execute(input: {
    tenantId: string;
    userId: string;
    role: Role;
    id: string;
    name?: string;
    position?: number;
  }): Promise<TopicModel> {
    const existing = await this.repo.getTopic(input.tenantId, input.id);
    if (!existing) throw new NotFoundException('Topic not found');

    return this.repo.updateTopic(input.tenantId, input.id, {
      name: input.name,
      position: input.position,
    });
  }
}

@Injectable()
export class DeleteTopicUseCase {
  constructor(@Inject(TAXONOMY_REPOSITORY) private readonly repo: ITaxonomyRepository) {}
  async execute(input: { tenantId: string; id: string }): Promise<void> {
    const existing = await this.repo.getTopic(input.tenantId, input.id);
    if (!existing) throw new NotFoundException('Topic not found');
    await this.repo.deleteTopic(input.tenantId, input.id);
  }
}

function isUniqueConstraintError(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'P2002'
  );
}
