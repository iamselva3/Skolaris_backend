import { BranchModel } from '../models/branch.model';

export const BRANCH_REPOSITORY = Symbol('BRANCH_REPOSITORY');

export interface IBranchRepository {
  create(tenantId: string, name: string): Promise<BranchModel>;
  findById(tenantId: string, id: string): Promise<BranchModel | null>;
  list(
    tenantId: string,
    limit: number,
    offset: number,
  ): Promise<{ data: BranchModel[]; total: number }>;
  update(tenantId: string, id: string, name: string): Promise<BranchModel>;
  softDelete(tenantId: string, id: string): Promise<void>;
}
