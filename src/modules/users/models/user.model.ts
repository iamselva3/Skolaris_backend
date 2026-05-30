import { Role } from '../../../shared/common/enums/role.enum';

export type UserStatus = 'ACTIVE' | 'DISABLED';

export class UserModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly branchId: string | null,
    public readonly email: string,
    public readonly passwordHash: string,
    public readonly name: string,
    public readonly role: Role,
    public readonly status: UserStatus,
    public readonly lastLoginAt: Date | null,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}

  isActive(): boolean {
    return this.status === 'ACTIVE';
  }
}
