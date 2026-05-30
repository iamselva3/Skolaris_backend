import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import {
  CLASSROOM_REPOSITORY,
  IClassroomRepository,
} from '../repositories/classroom.repository';

@Injectable()
export class AddStudentsToClassroomUseCase {
  constructor(
    @Inject(CLASSROOM_REPOSITORY) private readonly classrooms: IClassroomRepository,
  ) {}

  async execute(input: {
    actor: AuthenticatedUser;
    classroomId: string;
    studentIds: string[];
  }): Promise<{ added: string[]; alreadyMember: string[] }> {
    const target = await this.classrooms.findById(input.actor.tenantId, input.classroomId);
    if (!target) throw new NotFoundException('Classroom not found');
    if (input.actor.role === Role.TEACHER && target.createdBy !== input.actor.sub) {
      throw new ForbiddenException('Teachers can only modify classrooms they created');
    }
    return this.classrooms.addStudents(input.actor.tenantId, input.classroomId, input.studentIds);
  }
}
