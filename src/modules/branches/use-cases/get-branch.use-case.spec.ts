import { NotFoundException } from '@nestjs/common';
import { BranchModel } from '../models/branch.model';
import { IBranchRepository } from '../repositories/branch.repository';
import { GetBranchUseCase } from './get-branch.use-case';

describe('GetBranchUseCase', () => {
  let branches: jest.Mocked<IBranchRepository>;
  let useCase: GetBranchUseCase;

  beforeEach(() => {
    branches = {
      create: jest.fn(),
      findById: jest.fn(),
      list: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
    };
    useCase = new GetBranchUseCase(branches);
  });

  it('returns branch when found', async () => {
    branches.findById.mockResolvedValue(
      new BranchModel('b', 't', 'X', null, new Date(), new Date()),
    );
    const r = await useCase.execute({ tenantId: 't', id: 'b' });
    expect(r.id).toBe('b');
  });

  it('throws 404 when missing', async () => {
    branches.findById.mockResolvedValue(null);
    await expect(useCase.execute({ tenantId: 't', id: 'b' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
