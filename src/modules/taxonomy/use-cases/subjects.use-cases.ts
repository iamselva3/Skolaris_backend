import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { Role } from '../../../shared/common/enums/role.enum';
import { SubjectModel } from '../models/taxonomy.models';
import { ITaxonomyRepository, TAXONOMY_REPOSITORY } from '../repositories/taxonomy.repository';

@Injectable()
export class ListSubjectsUseCase {
  constructor(@Inject(TAXONOMY_REPOSITORY) private readonly repo: ITaxonomyRepository) {}
  execute(input: {
    tenantId: string;
    programId?: string;
    isActive?: boolean;
  }): Promise<SubjectModel[]> {
    return this.repo.listSubjects(input);
  }
}

@Injectable()
export class GetSubjectUseCase {
  constructor(@Inject(TAXONOMY_REPOSITORY) private readonly repo: ITaxonomyRepository) {}
  async execute(input: { tenantId: string; id: string }): Promise<SubjectModel> {
    const s = await this.repo.getSubject(input.tenantId, input.id);
    if (!s) throw new NotFoundException('Subject not found');
    return s;
  }
}

@Injectable()
export class CreateSubjectUseCase {
  constructor(@Inject(TAXONOMY_REPOSITORY) private readonly repo: ITaxonomyRepository) {}
  async execute(input: {
    actor: AuthenticatedUser;
    tenantId: string;
    programId: string;
    name: string;
  }): Promise<SubjectModel> {
    const program = await this.repo.getProgram(input.tenantId, input.programId);
    if (!program) throw new NotFoundException('Program not found');
    try {
      const subject = await this.repo.createSubject({
        tenantId: input.tenantId,
        programId: input.programId,
        name: input.name,
      });

      if (input.actor.role === Role.TEACHER) {
        await this.repo.assignTeacherSubjects({
          tenantId: input.tenantId,
          userId: input.actor.sub,
          subjectIds: [subject.id],
        });
      }

      return subject;
    } catch (e: unknown) {
      if (isUniqueConstraintError(e)) {
        throw new ConflictException('A subject with that name already exists for this program');
      }
      throw e;
    }
  }
}

@Injectable()
export class UpdateSubjectUseCase {
  constructor(@Inject(TAXONOMY_REPOSITORY) private readonly repo: ITaxonomyRepository) {}
  async execute(input: {
    tenantId: string;
    id: string;
    name?: string;
    isActive?: boolean;
  }): Promise<SubjectModel> {
    const existing = await this.repo.getSubject(input.tenantId, input.id);
    if (!existing) throw new NotFoundException('Subject not found');
    return this.repo.updateSubject(input.tenantId, input.id, {
      name: input.name,
      isActive: input.isActive,
    });
  }
}

@Injectable()
export class ListMySubjectsUseCase {
  constructor(@Inject(TAXONOMY_REPOSITORY) private readonly repo: ITaxonomyRepository) {}
  execute(input: { tenantId: string; userId: string }): Promise<SubjectModel[]> {
    return this.repo.listSubjectsForTeacher(input.tenantId, input.userId);
  }
}

function isUniqueConstraintError(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'P2002'
  );
}
