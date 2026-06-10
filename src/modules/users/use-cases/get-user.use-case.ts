import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { UserModel } from '../models/user.model';
import { IUserRepository, USER_REPOSITORY } from '../repositories/user.repository';

@Injectable()
export class GetUserUseCase {
  constructor(@Inject(USER_REPOSITORY) private readonly users: IUserRepository) {}

  async execute(input: { actor: AuthenticatedUser; id: string }): Promise<UserModel> {
    const user = await this.users.findById(input.actor.tenantId, input.id);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const { actor } = input;
    if (actor.role === Role.STUDENT && actor.sub !== user.id) {
      throw new ForbiddenException('Students may only read their own profile');
    }
    return user;
  }
}
