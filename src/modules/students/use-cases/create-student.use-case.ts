import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import {
  IUserRepository,
  USER_REPOSITORY,
} from '../../users/repositories/user.repository';
import {
  IStudentRepository,
  STUDENT_REPOSITORY,
  StudentWithUser,
} from '../repositories/student.repository';

export interface CreateStudentInput {
  actor: AuthenticatedUser;
  email: string;
  name: string;
  password: string;
  branchId: string;
  classLabel?: string;
  rollNo?: string;
  parentContact?: string;
}

@Injectable()
export class CreateStudentUseCase {
  constructor(
    @Inject(STUDENT_REPOSITORY) private readonly students: IStudentRepository,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
  ) {}

  async execute(input: CreateStudentInput): Promise<StudentWithUser> {
    if (input.actor.role === Role.TEACHER) {
      if (!input.actor.branchId || input.branchId !== input.actor.branchId) {
        throw new ForbiddenException('Teachers can only add students in their own branch');
      }
    }

    const existing = await this.users.findByEmail(input.actor.tenantId, input.email);
    if (existing) {
      throw new ConflictException('A user with that email already exists in this tenant');
    }

    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    return this.students.createWithUser({
      tenantId: input.actor.tenantId,
      branchId: input.branchId,
      classLabel: input.classLabel,
      rollNo: input.rollNo,
      parentContact: input.parentContact,
      user: {
        email: input.email,
        name: input.name,
        passwordHash,
      },
    });
  }
}
