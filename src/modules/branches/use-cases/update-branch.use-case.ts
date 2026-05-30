import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { BranchModel } from '../models/branch.model';
import {
  BRANCH_REPOSITORY,
  IBranchRepository,
} from '../repositories/branch.repository';

@Injectable()
export class UpdateBranchUseCase {
  constructor(@Inject(BRANCH_REPOSITORY) private readonly branches: IBranchRepository) {}

  async execute(input: { tenantId: string; id: string; name?: string }): Promise<BranchModel> {
    if (input.name === undefined) {
      throw new BadRequestException('No fields to update');
    }
    return this.branches.update(input.tenantId, input.id, input.name);
  }
}
