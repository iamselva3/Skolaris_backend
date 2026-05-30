import { BadRequestException } from '@nestjs/common';
import { BranchModel } from '../models/branch.model';
import { IBranchRepository } from '../repositories/branch.repository';
import { UpdateBranchUseCase } from './update-branch.use-case';

describe('UpdateBranchUseCase', () => {
  it('updates the branch when name is provided', async () => {
    const branches: jest.Mocked<IBranchRepository> = {
      create: jest.fn(),
      findById: jest.fn(),
      list: jest.fn(),
      update: jest
        .fn()
        .mockResolvedValue(new BranchModel('b', 't', 'New', null, new Date(), new Date())),
      softDelete: jest.fn(),
    };
    const useCase = new UpdateBranchUseCase(branches);
    const r = await useCase.execute({ tenantId: 't', id: 'b', name: 'New' });
    expect(r.name).toBe('New');
    expect(branches.update).toHaveBeenCalledWith('t', 'b', 'New');
  });

  it('throws 400 if no fields provided', async () => {
    const branches: jest.Mocked<IBranchRepository> = {
      create: jest.fn(),
      findById: jest.fn(),
      list: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
    };
    const useCase = new UpdateBranchUseCase(branches);
    await expect(useCase.execute({ tenantId: 't', id: 'b' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
