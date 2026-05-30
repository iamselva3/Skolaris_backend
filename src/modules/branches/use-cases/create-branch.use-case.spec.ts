import { BranchModel } from '../models/branch.model';
import { IBranchRepository } from '../repositories/branch.repository';
import { CreateBranchUseCase } from './create-branch.use-case';

describe('CreateBranchUseCase', () => {
  it('delegates to repository with tenant scope', async () => {
    const branches: jest.Mocked<IBranchRepository> = {
      create: jest
        .fn()
        .mockResolvedValue(new BranchModel('b-1', 't-1', 'X', null, new Date(), new Date())),
      findById: jest.fn(),
      list: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
    };
    const useCase = new CreateBranchUseCase(branches);
    const r = await useCase.execute({ tenantId: 't-1', name: 'X' });
    expect(r.id).toBe('b-1');
    expect(branches.create).toHaveBeenCalledWith('t-1', 'X');
  });
});
