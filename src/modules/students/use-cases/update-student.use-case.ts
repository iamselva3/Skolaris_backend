import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import {
  AssignMemberToClassroomUseCase,
  ClassroomAssignment,
} from '../../classrooms/use-cases/assign-member-to-classroom.use-case';
import {
  IStudentRepository,
  STUDENT_REPOSITORY,
  StudentWithUser,
  UpdateStudentInput as RepoUpdate,
} from '../repositories/student.repository';

export interface UpdateStudentInput {
  actor: AuthenticatedUser;
  id: string;
  classLabel?: string | null;
  rollNo?: string | null;
  parentContact?: string | null;
  branchId?: string;
  classroom?: ClassroomAssignment;
}

@Injectable()
export class UpdateStudentUseCase {
  constructor(
    @Inject(STUDENT_REPOSITORY) private readonly students: IStudentRepository,
    private readonly assignToClassroom: AssignMemberToClassroomUseCase,
  ) {}

  async execute(input: UpdateStudentInput): Promise<StudentWithUser> {
    const target = await this.students.findById(input.actor.tenantId, input.id);
    if (!target) {
      throw new NotFoundException('Student not found');
    }

    const repoInput: RepoUpdate = {};
    if (input.classLabel !== undefined) repoInput.classLabel = input.classLabel;
    if (input.rollNo !== undefined) repoInput.rollNo = input.rollNo;
    if (input.parentContact !== undefined) repoInput.parentContact = input.parentContact;
    if (input.branchId !== undefined) {
      if (input.actor.role === Role.TEACHER) {
        if (!input.actor.branchId || input.branchId !== input.actor.branchId) {
          throw new ForbiddenException('Teachers can only move students within their own branch');
        }
      }
      repoInput.branchId = input.branchId;
    }

    if (Object.keys(repoInput).length === 0 && !input.classroom) {
      throw new BadRequestException('No fields to update');
    }

    if (input.actor.role === Role.TEACHER) {
      if (!input.actor.branchId || target.student.branchId !== input.actor.branchId) {
        throw new ForbiddenException('Teachers can only update students in their own branch');
      }
    }

    let updated = target;
    if (Object.keys(repoInput).length > 0) {
      updated = await this.students.update(input.actor.tenantId, input.id, repoInput);
    }

    if (input.classroom) {
      const branchId = repoInput.branchId ?? target.student.branchId;
      if (!branchId) {
        throw new BadRequestException('Cannot assign classroom without a branch ID');
      }
      await this.assignToClassroom.execute({
        actor: input.actor,
        branchId,
        assignment: input.classroom,
        studentId: target.student.id,
        replaceExistingStudent: true,
      });
      // Refresh the student to get the updated classroom
      updated = (await this.students.findById(input.actor.tenantId, input.id))!;
    }

    return updated;
  }
}
