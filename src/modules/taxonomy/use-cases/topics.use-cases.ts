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
  execute(input: { tenantId: string; subjectId?: string }): Promise<TopicModel[]> {
    return this.repo.listTopics(input.tenantId, input.subjectId);
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
    subjectId: string;
    name: string;
    position?: number;
  }): Promise<TopicModel> {
    const subject = await this.repo.getSubject(input.tenantId, input.subjectId);
    if (!subject) throw new NotFoundException('Subject not found');

    try {
      return await this.repo.createTopic({
        tenantId: input.tenantId,
        subjectId: input.subjectId,
        name: input.name,
        position: input.position,
      });
    } catch (e: unknown) {
      if (isUniqueConstraintError(e)) {
        throw new ConflictException('A topic with that name already exists for this subject');
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
