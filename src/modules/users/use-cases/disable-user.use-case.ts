import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  IUserRepository,
  USER_REPOSITORY,
} from '../repositories/user.repository';

@Injectable()
export class DisableUserUseCase {
  constructor(@Inject(USER_REPOSITORY) private readonly users: IUserRepository) {}

  async execute(input: { tenantId: string; id: string }): Promise<void> {
    const user = await this.users.findById(input.tenantId, input.id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    await this.users.disable(input.tenantId, input.id);
  }
}
