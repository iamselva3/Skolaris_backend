import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { ClassroomModel } from '../models/classroom.model';
import { CLASSROOM_REPOSITORY, IClassroomRepository } from '../repositories/classroom.repository';
import { normalizeClassroomIdentity } from './normalize-classroom';

export interface CreateClassroomInput {
  actor: AuthenticatedUser;
  name: string;
  branchId: string;
  year?: string;
  section?: string;
  subject?: string;
  teacherIds?: string[];
}

@Injectable()
export class CreateClassroomUseCase {
  constructor(@Inject(CLASSROOM_REPOSITORY) private readonly classrooms: IClassroomRepository) {}

  async execute(input: CreateClassroomInput): Promise<ClassroomModel> {
    if (input.actor.role === Role.TEACHER) {
      if (!input.actor.branchId || input.branchId !== input.actor.branchId) {
        throw new ForbiddenException('Teachers can only create classrooms in their own branch');
      }
    }

    const createdBy = input.actor.sub;
    let teacherIds = input.teacherIds || [];

    if (input.actor.role === Role.TEACHER && teacherIds.length === 0) {
      teacherIds = [input.actor.sub];
    }

    const identity = normalizeClassroomIdentity(input);

    const existing = await this.classrooms.findByUniqueAttributes(
      input.actor.tenantId,
      input.branchId,
      identity.name,
      identity.year,
      identity.section,
      identity.subject,
    );
    if (existing) {
      throw new ConflictException(
        'A classroom with this discipline, batch name, year, and section already exists.',
      );
    }

    return this.classrooms.create({
      tenantId: input.actor.tenantId,
      branchId: input.branchId,
      name: identity.name,
      year: identity.year,
      section: identity.section,
      subject: identity.subject,
      createdBy,
      teacherIds,
    });
  }
}
