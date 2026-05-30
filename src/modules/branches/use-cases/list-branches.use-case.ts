import { Inject, Injectable } from '@nestjs/common';
import { PaginatedResponse } from '../../../shared/common/dtos/paginated-response.dto';
import { BranchModel } from '../models/branch.model';
import {
  BRANCH_REPOSITORY,
  IBranchRepository,
} from '../repositories/branch.repository';

@Injectable()
export class ListBranchesUseCase {
  constructor(@Inject(BRANCH_REPOSITORY) private readonly branches: IBranchRepository) {}

  async execute(input: {
    tenantId: string;
    limit: number;
    offset: number;
  }): Promise<PaginatedResponse<BranchModel>> {
    const { data, total } = await this.branches.list(input.tenantId, input.limit, input.offset);
    return { data, meta: { total, limit: input.limit, offset: input.offset } };
  }
}
