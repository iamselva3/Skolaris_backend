import { TenantModel } from '../models/tenant.model';
import { ITenantRepository } from '../repositories/tenant.repository';
import { ListTenantsUseCase } from './list-tenants.use-case';

describe('ListTenantsUseCase', () => {
  it('passes through limit/offset and wraps meta', async () => {
    const tenants: jest.Mocked<ITenantRepository> = {
      createWithAdmin: jest.fn(),
      findById: jest.fn(),
      findBySlug: jest.fn(),
      list: jest.fn().mockResolvedValue({
        data: [new TenantModel('t', 'n', 's', 'ACTIVE', new Date(), new Date())],
        total: 1,
      }),
      update: jest.fn(),
    };
    const useCase = new ListTenantsUseCase(tenants);
    const r = await useCase.execute({ limit: 10, offset: 0 });
    expect(r.meta).toEqual({ total: 1, limit: 10, offset: 0 });
    expect(tenants.list).toHaveBeenCalledWith(10, 0);
  });
});
