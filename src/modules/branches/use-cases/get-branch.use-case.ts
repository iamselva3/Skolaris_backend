import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { BranchModel } from '../models/branch.model';
import { BRANCH_REPOSITORY, IBranchRepository } from '../repositories/branch.repository';

@Injectable()
export class GetBranchUseCase {
  constructor(@Inject(BRANCH_REPOSITORY) private readonly branches: IBranchRepository) {}

  async execute(input: { tenantId: string; id: string }): Promise<BranchModel> {
    const branch = await this.branches.findById(input.tenantId, input.id);
    if (!branch) {
      throw new NotFoundException('Branch not found');
    }
    return branch;
  }
}
