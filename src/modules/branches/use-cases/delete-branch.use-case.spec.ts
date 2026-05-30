import { IBranchRepository } from '../repositories/branch.repository';
import { DeleteBranchUseCase } from './delete-branch.use-case';

describe('DeleteBranchUseCase', () => {
  it('delegates soft-delete to repository', async () => {
    const branches: jest.Mocked<IBranchRepository> = {
      create: jest.fn(),
      findById: jest.fn(),
      list: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn().mockResolvedValue(undefined),
    };
    const useCase = new DeleteBranchUseCase(branches);
    await useCase.execute({ tenantId: 't', id: 'b' });
    expect(branches.softDelete).toHaveBeenCalledWith('t', 'b');
  });
});
