import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ProgramModel } from '../models/taxonomy.models';
import {
  ITaxonomyRepository,
  TAXONOMY_REPOSITORY,
} from '../repositories/taxonomy.repository';

@Injectable()
export class ListProgramsUseCase {
  constructor(@Inject(TAXONOMY_REPOSITORY) private readonly repo: ITaxonomyRepository) {}
  execute(tenantId: string): Promise<ProgramModel[]> {
    return this.repo.listPrograms(tenantId);
  }
}

@Injectable()
export class GetProgramUseCase {
  constructor(@Inject(TAXONOMY_REPOSITORY) private readonly repo: ITaxonomyRepository) {}
  async execute(input: { tenantId: string; id: string }): Promise<ProgramModel> {
    const p = await this.repo.getProgram(input.tenantId, input.id);
    if (!p) throw new NotFoundException('Program not found');
    return p;
  }
}

@Injectable()
export class CreateProgramUseCase {
  constructor(@Inject(TAXONOMY_REPOSITORY) private readonly repo: ITaxonomyRepository) {}
  async execute(input: {
    tenantId: string;
    code: string;
    name: string;
  }): Promise<ProgramModel> {
    const existing = await this.repo.getProgramByCode(input.tenantId, input.code);
    if (existing) throw new ConflictException('A program with that code already exists');
    return this.repo.createProgram(input);
  }
}

@Injectable()
export class UpdateProgramUseCase {
  constructor(@Inject(TAXONOMY_REPOSITORY) private readonly repo: ITaxonomyRepository) {}
  async execute(input: {
    tenantId: string;
    id: string;
    name?: string;
    isActive?: boolean;
  }): Promise<ProgramModel> {
    const existing = await this.repo.getProgram(input.tenantId, input.id);
    if (!existing) throw new NotFoundException('Program not found');
    return this.repo.updateProgram(input.tenantId, input.id, {
      name: input.name,
      isActive: input.isActive,
    });
  }
}
