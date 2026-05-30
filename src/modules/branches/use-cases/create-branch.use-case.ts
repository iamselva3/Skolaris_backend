import { Inject, Injectable } from '@nestjs/common';
import { BranchModel } from '../models/branch.model';
import {
  BRANCH_REPOSITORY,
  IBranchRepository,
} from '../repositories/branch.repository';

@Injectable()
export class CreateBranchUseCase {
  constructor(@Inject(BRANCH_REPOSITORY) private readonly branches: IBranchRepository) {}

  execute(input: { tenantId: string; name: string }): Promise<BranchModel> {
    return this.branches.create(input.tenantId, input.name);
  }
}
