import { Role } from '../../../shared/common/enums/role.enum';
import { UserModel, UserStatus } from '../models/user.model';

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

export interface CreateUserInput {
  tenantId: string;
  branchId?: string | null;
  email: string;
  passwordHash: string;
  name: string;
  role: Role;
}

export interface UpdateUserInput {
  name?: string;
  passwordHash?: string;
  branchId?: string | null;
  status?: UserStatus;
}

export interface ListUsersFilter {
  tenantId: string;
  role?: Role;
  branchId?: string | null;
  limit?: number;
  offset?: number;
}

export interface IUserRepository {
  create(input: CreateUserInput): Promise<UserModel>;
  findById(tenantId: string, id: string): Promise<UserModel | null>;
  findByIdAnyTenant(id: string): Promise<UserModel | null>;
  findByEmail(tenantId: string, email: string): Promise<UserModel | null>;
  findByEmailGlobal(email: string): Promise<UserModel | null>;
  list(filter: ListUsersFilter): Promise<{ data: UserModel[]; total: number }>;
  update(tenantId: string, id: string, input: UpdateUserInput): Promise<UserModel>;
  disable(tenantId: string, id: string): Promise<void>;
  recordLogin(id: string): Promise<void>;
}
