import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { ClassroomModel } from '../models/classroom.model';
import {
  CLASSROOM_REPOSITORY,
  IClassroomRepository,
} from '../repositories/classroom.repository';

export interface CreateClassroomInput {
  actor: AuthenticatedUser;
  name: string;
  branchId: string;
  year?: string;
  section?: string;
  subject?: string;
  teacherId?: string;
}

@Injectable()
export class CreateClassroomUseCase {
  constructor(
    @Inject(CLASSROOM_REPOSITORY) private readonly classrooms: IClassroomRepository,
  ) {}

  execute(input: CreateClassroomInput): Promise<ClassroomModel> {
    if (input.actor.role === Role.TEACHER) {
      if (!input.actor.branchId || input.branchId !== input.actor.branchId) {
        throw new ForbiddenException('Teachers can only create classrooms in their own branch');
      }
    }
    
    let createdBy = input.actor.sub;
    if (input.actor.role === Role.SUPER_ADMIN && input.teacherId) {
      createdBy = input.teacherId;
    }

    return this.classrooms.create({
      tenantId: input.actor.tenantId,
      branchId: input.branchId,
      name: input.name,
      year: input.year,
      section: input.section,
      subject: input.subject,
      createdBy,
    });
  }
}
