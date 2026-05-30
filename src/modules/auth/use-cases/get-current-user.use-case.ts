import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CurrentUserResponse } from '../dtos/auth-response.dto';
import {
  IUserRepository,
  USER_REPOSITORY,
} from '../../users/repositories/user.repository';

@Injectable()
export class GetCurrentUserUseCase {
  constructor(@Inject(USER_REPOSITORY) private readonly users: IUserRepository) {}

  async execute(input: { userId: string; tenantId: string }): Promise<CurrentUserResponse> {
    const user = await this.users.findById(input.tenantId, input.userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return {
      id: user.id,
      tenantId: user.tenantId,
      branchId: user.branchId,
      email: user.email,
      name: user.name,
      role: user.role,
    };
  }
}
