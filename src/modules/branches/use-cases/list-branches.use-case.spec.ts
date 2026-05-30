import { BranchModel } from '../models/branch.model';
import { IBranchRepository } from '../repositories/branch.repository';
import { ListBranchesUseCase } from './list-branches.use-case';

describe('ListBranchesUseCase', () => {
  it('returns paginated branches scoped to tenant', async () => {
    const branches: jest.Mocked<IBranchRepository> = {
      create: jest.fn(),
      findById: jest.fn(),
      list: jest.fn().mockResolvedValue({
        data: [new BranchModel('b', 't', 'X', null, new Date(), new Date())],
        total: 1,
      }),
      update: jest.fn(),
      softDelete: jest.fn(),
    };
    const useCase = new ListBranchesUseCase(branches);
    const r = await useCase.execute({ tenantId: 't', limit: 10, offset: 0 });
    expect(branches.list).toHaveBeenCalledWith('t', 10, 0);
    expect(r.meta.total).toBe(1);
  });
});
