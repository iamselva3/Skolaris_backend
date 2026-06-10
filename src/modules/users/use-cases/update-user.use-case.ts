import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { UserModel, UserStatus } from '../models/user.model';
import {
  IUserRepository,
  USER_REPOSITORY,
  UpdateUserInput as RepoUpdateUserInput,
} from '../repositories/user.repository';

export interface UpdateUserInput {
  actor: AuthenticatedUser;
  id: string;
  name?: string;
  password?: string;
  branchId?: string | null;
  status?: UserStatus;
  phone?: string | null;
}

@Injectable()
export class UpdateUserUseCase {
  constructor(@Inject(USER_REPOSITORY) private readonly users: IUserRepository) {}

  async execute(input: UpdateUserInput): Promise<UserModel> {
    const target = await this.users.findById(input.actor.tenantId, input.id);
    if (!target) {
      throw new NotFoundException('User not found');
    }

    const isSelf = input.actor.sub === target.id;
    const isSuperAdmin = input.actor.role === Role.SUPER_ADMIN;

    if (!isSelf && !isSuperAdmin) {
      throw new ForbiddenException('Insufficient permission to update this user');
    }

    const update: RepoUpdateUserInput = {};

    if (input.name !== undefined) update.name = input.name;
    if (input.phone !== undefined) update.phone = input.phone;
    if (input.password !== undefined) {
      update.passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    }

    if (input.branchId !== undefined) {
      if (!isSuperAdmin) {
        throw new ForbiddenException('Only SUPER_ADMIN may change branch');
      }
      update.branchId = input.branchId;
    }

    if (input.status !== undefined) {
      if (!isSuperAdmin) {
        throw new ForbiddenException('Only SUPER_ADMIN may change status');
      }
      update.status = input.status;
    }

    if (Object.keys(update).length === 0) {
      throw new BadRequestException('No fields to update');
    }

    return this.users.update(input.actor.tenantId, input.id, update);
  }
}
