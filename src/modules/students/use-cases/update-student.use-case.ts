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
}

@Injectable()
export class UpdateStudentUseCase {
  constructor(@Inject(STUDENT_REPOSITORY) private readonly students: IStudentRepository) {}

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

    if (Object.keys(repoInput).length === 0) {
      throw new BadRequestException('No fields to update');
    }

    if (input.actor.role === Role.TEACHER) {
      if (!input.actor.branchId || target.student.branchId !== input.actor.branchId) {
        throw new ForbiddenException('Teachers can only update students in their own branch');
      }
    }

    return this.students.update(input.actor.tenantId, input.id, repoInput);
  }
}
