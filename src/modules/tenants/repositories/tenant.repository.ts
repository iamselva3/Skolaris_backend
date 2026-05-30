import { TenantModel, TenantStatus } from '../models/tenant.model';
import { UserModel } from '../../users/models/user.model';

export const TENANT_REPOSITORY = Symbol('TENANT_REPOSITORY');

export interface CreateTenantWithAdminInput {
  name: string;
  slug: string;
  admin: {
    email: string;
    name: string;
    passwordHash: string;
  };
}

export interface UpdateTenantInput {
  name?: string;
  status?: TenantStatus;
}

export interface ITenantRepository {
  createWithAdmin(
    input: CreateTenantWithAdminInput,
  ): Promise<{ tenant: TenantModel; admin: UserModel }>;
  findById(id: string): Promise<TenantModel | null>;
  findBySlug(slug: string): Promise<TenantModel | null>;
  list(limit: number, offset: number): Promise<{ data: TenantModel[]; total: number }>;
  update(id: string, input: UpdateTenantInput): Promise<TenantModel>;
}
