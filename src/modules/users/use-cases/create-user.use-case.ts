import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { UserModel } from '../models/user.model';
import {
  IUserRepository,
  USER_REPOSITORY,
} from '../repositories/user.repository';

export interface CreateUserInput {
  actor: AuthenticatedUser;
  email: string;
  name: string;
  password: string;
  role: Role;
  branchId?: string;
}

@Injectable()
export class CreateUserUseCase {
  constructor(@Inject(USER_REPOSITORY) private readonly users: IUserRepository) {}

  async execute(input: CreateUserInput): Promise<UserModel> {
    this.assertCanCreate(input);

    const existing = await this.users.findByEmail(input.actor.tenantId, input.email);
    if (existing) {
      throw new ConflictException('A user with that email already exists in this tenant');
    }

    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    return this.users.create({
      tenantId: input.actor.tenantId,
      branchId: input.branchId ?? null,
      email: input.email,
      passwordHash,
      name: input.name,
      role: input.role,
    });
  }

  private assertCanCreate(input: CreateUserInput): void {
    const { actor } = input;

    if (actor.role === Role.SUPER_ADMIN) {
      return;
    }

    if (actor.role === Role.TEACHER) {
      if (input.role !== Role.STUDENT) {
        throw new ForbiddenException('Teachers can only create STUDENT users');
      }
      if (!input.branchId) {
        throw new BadRequestException('Teachers must assign a branchId when creating students');
      }
      if (actor.branchId === null || input.branchId !== actor.branchId) {
        throw new ForbiddenException("Teachers can only create students in their own branch");
      }
      return;
    }

    throw new ForbiddenException('Insufficient role to create users');
  }
}
