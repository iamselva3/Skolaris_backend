import { NotFoundException } from '@nestjs/common';
import { TenantModel } from '../models/tenant.model';
import { ITenantRepository } from '../repositories/tenant.repository';
import { GetTenantUseCase } from './get-tenant.use-case';

describe('GetTenantUseCase', () => {
  let tenants: jest.Mocked<ITenantRepository>;
  let useCase: GetTenantUseCase;

  beforeEach(() => {
    tenants = {
      createWithAdmin: jest.fn(),
      findById: jest.fn(),
      findBySlug: jest.fn(),
      list: jest.fn(),
      update: jest.fn(),
    };
    useCase = new GetTenantUseCase(tenants);
  });

  it('returns tenant when found', async () => {
    tenants.findById.mockResolvedValue(
      new TenantModel('t-1', 'A', 'a', 'ACTIVE', new Date(), new Date()),
    );
    const r = await useCase.execute('t-1');
    expect(r.id).toBe('t-1');
  });

  it('throws 404 when not found', async () => {
    tenants.findById.mockResolvedValue(null);
    await expect(useCase.execute('t-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
