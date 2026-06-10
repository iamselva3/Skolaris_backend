import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { ClassroomModel } from '../models/classroom.model';
import {
  CLASSROOM_REPOSITORY,
  IClassroomRepository,
  UpdateClassroomInput as RepoUpdate,
} from '../repositories/classroom.repository';

export interface UpdateClassroomInput {
  actor: AuthenticatedUser;
  id: string;
  name?: string;
  year?: string | null;
  section?: string | null;
  subject?: string | null;
  teacherIds?: string[];
}

@Injectable()
export class UpdateClassroomUseCase {
  constructor(@Inject(CLASSROOM_REPOSITORY) private readonly classrooms: IClassroomRepository) {}

  async execute(input: UpdateClassroomInput): Promise<ClassroomModel> {
    const target = await this.classrooms.findById(input.actor.tenantId, input.id);
    if (!target) throw new NotFoundException('Classroom not found');

    if (input.actor.role === Role.TEACHER && target.createdBy !== input.actor.sub && !target.teacherIds?.includes(input.actor.sub)) {
      throw new ForbiddenException('Teachers can only edit classrooms they created or are assigned to');
    }

    const repoInput: RepoUpdate = {};
    if (input.name !== undefined) repoInput.name = input.name.trim().toUpperCase();
    if (input.year !== undefined) repoInput.year = input.year;
    if (input.section !== undefined)
      repoInput.section = input.section ? input.section.trim().toUpperCase() : input.section;
    if (input.subject !== undefined) repoInput.subject = input.subject;
    if (input.teacherIds !== undefined && input.actor.role === Role.SUPER_ADMIN) {
      repoInput.teacherIds = input.teacherIds;
    }
    if (Object.keys(repoInput).length === 0) {
      throw new BadRequestException('No fields to update');
    }

    const checkName = repoInput.name !== undefined ? repoInput.name : target.name;
    const checkYear = repoInput.year !== undefined ? repoInput.year : target.year;
    const checkSection = repoInput.section !== undefined ? repoInput.section : target.section;

    if (checkName !== target.name || checkYear !== target.year || checkSection !== target.section) {
      const existing = await this.classrooms.findByUniqueAttributes(
        input.actor.tenantId,
        target.branchId,
        checkName,
        checkYear,
        checkSection,
      );
      if (existing && existing.id !== target.id) {
        throw new ConflictException(
          'A classroom with this batch name, year, and section already exists.',
        );
      }
    }

    return this.classrooms.update(input.actor.tenantId, input.id, repoInput);
  }
}
