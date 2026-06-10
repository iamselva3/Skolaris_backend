import { Inject, Injectable } from '@nestjs/common';
import { PaginatedResponse } from '../../../shared/common/dtos/paginated-response.dto';
import { Role } from '../../../shared/common/enums/role.enum';
import { UserModel } from '../models/user.model';
import { IUserRepository, USER_REPOSITORY } from '../repositories/user.repository';

@Injectable()
export class ListUsersUseCase {
  constructor(@Inject(USER_REPOSITORY) private readonly users: IUserRepository) {}

  async execute(input: {
    tenantId: string;
    role?: Role;
    branchId?: string;
    limit: number;
    offset: number;
  }): Promise<PaginatedResponse<UserModel>> {
    const { data, total } = await this.users.list({
      tenantId: input.tenantId,
      role: input.role,
      branchId: input.branchId,
      limit: input.limit,
      offset: input.offset,
    });
    return { data, meta: { total, limit: input.limit, offset: input.offset } };
  }
}
