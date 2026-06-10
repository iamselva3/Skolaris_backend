import { Inject, Injectable } from '@nestjs/common';
import { BRANCH_REPOSITORY, IBranchRepository } from '../repositories/branch.repository';

@Injectable()
export class DeleteBranchUseCase {
  constructor(@Inject(BRANCH_REPOSITORY) private readonly branches: IBranchRepository) {}

  execute(input: { tenantId: string; id: string }): Promise<void> {
    return this.branches.softDelete(input.tenantId, input.id);
  }
}
