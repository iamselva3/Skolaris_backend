import { ConflictException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { Role } from '../../../shared/common/enums/role.enum';
import { UserModel } from '../../users/models/user.model';
import { TenantModel } from '../models/tenant.model';
import { ITenantRepository } from '../repositories/tenant.repository';
import { CreateTenantUseCase } from './create-tenant.use-case';

describe('CreateTenantUseCase', () => {
  let tenants: jest.Mocked<ITenantRepository>;
  let useCase: CreateTenantUseCase;

  beforeEach(() => {
    tenants = {
      createWithAdmin: jest.fn(),
      findById: jest.fn(),
      findBySlug: jest.fn(),
      list: jest.fn(),
      update: jest.fn(),
    };
    useCase = new CreateTenantUseCase(tenants);
  });

  it('creates tenant and hashed admin user', async () => {
    tenants.findBySlug.mockResolvedValue(null);
    tenants.createWithAdmin.mockImplementation(async (input) => ({
      tenant: new TenantModel('t-1', input.name, input.slug, 'ACTIVE', new Date(), new Date()),
      admin: new UserModel(
        'u-1',
        't-1',
        null,
        input.admin.email,
        null,
        input.admin.passwordHash,
        input.admin.name,
        Role.SUPER_ADMIN,
        'ACTIVE',
        null,
        new Date(),
        new Date(),
      ),
    }));

    const result = await useCase.execute({
      name: 'Acme',
      slug: 'acme',
      admin: { email: 'a@acme.test', name: 'Owner', password: 'Password1!' },
    });

    expect(result.id).toBe('t-1');
    expect(result.admin.email).toBe('a@acme.test');

    const call = tenants.createWithAdmin.mock.calls[0][0];
    const hashed = call.admin.passwordHash;
    expect(hashed).not.toBe('Password1!');
    await expect(argon2.verify(hashed, 'Password1!')).resolves.toBe(true);
  });

  it('rejects duplicate slug', async () => {
    tenants.findBySlug.mockResolvedValue(
      new TenantModel('t-existing', 'X', 'acme', 'ACTIVE', new Date(), new Date()),
    );
    await expect(
      useCase.execute({
        name: 'Acme',
        slug: 'acme',
        admin: { email: 'a@acme.test', name: 'Owner', password: 'Password1!' },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
