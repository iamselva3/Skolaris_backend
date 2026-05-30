import { Module } from '@nestjs/common';
import { BranchesController } from './controllers/branches.controller';
import { PrismaBranchRepository } from './repositories/prisma-branch.repository';
import { BRANCH_REPOSITORY } from './repositories/branch.repository';
import { CreateBranchUseCase } from './use-cases/create-branch.use-case';
import { DeleteBranchUseCase } from './use-cases/delete-branch.use-case';
import { GetBranchUseCase } from './use-cases/get-branch.use-case';
import { ListBranchesUseCase } from './use-cases/list-branches.use-case';
import { UpdateBranchUseCase } from './use-cases/update-branch.use-case';

@Module({
  controllers: [BranchesController],
  providers: [
    CreateBranchUseCase,
    ListBranchesUseCase,
    GetBranchUseCase,
    UpdateBranchUseCase,
    DeleteBranchUseCase,
    { provide: BRANCH_REPOSITORY, useClass: PrismaBranchRepository },
  ],
  exports: [BRANCH_REPOSITORY],
})
export class BranchesModule {}
