import { NotFoundException } from '@nestjs/common';
import { TenantModel } from '../models/tenant.model';
import { ITenantRepository } from '../repositories/tenant.repository';
import { UpdateTenantUseCase } from './update-tenant.use-case';

describe('UpdateTenantUseCase', () => {
  let tenants: jest.Mocked<ITenantRepository>;
  let useCase: UpdateTenantUseCase;

  beforeEach(() => {
    tenants = {
      createWithAdmin: jest.fn(),
      findById: jest.fn(),
      findBySlug: jest.fn(),
      list: jest.fn(),
      update: jest.fn(),
    };
    useCase = new UpdateTenantUseCase(tenants);
  });

  it('updates an existing tenant', async () => {
    tenants.findById.mockResolvedValue(
      new TenantModel('t-1', 'Old', 's', 'ACTIVE', new Date(), new Date()),
    );
    tenants.update.mockResolvedValue(
      new TenantModel('t-1', 'New', 's', 'SUSPENDED', new Date(), new Date()),
    );
    const r = await useCase.execute({ id: 't-1', name: 'New', status: 'SUSPENDED' });
    expect(r.name).toBe('New');
    expect(tenants.update).toHaveBeenCalledWith('t-1', { name: 'New', status: 'SUSPENDED' });
  });

  it('throws 404 when tenant missing', async () => {
    tenants.findById.mockResolvedValue(null);
    await expect(useCase.execute({ id: 't-1', name: 'X' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
