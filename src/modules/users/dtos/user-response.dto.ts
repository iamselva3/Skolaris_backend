import { Role } from '../../../shared/common/enums/role.enum';
import { UserModel, UserStatus } from '../models/user.model';

export interface UserResponse {
  id: string;
  tenantId: string;
  branchId: string | null;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const toUserResponse = (u: UserModel): UserResponse => ({
  id: u.id,
  tenantId: u.tenantId,
  branchId: u.branchId,
  email: u.email,
  name: u.name,
  role: u.role,
  status: u.status,
  lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
  createdAt: u.createdAt.toISOString(),
  updatedAt: u.updatedAt.toISOString(),
});
