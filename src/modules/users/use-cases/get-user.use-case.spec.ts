import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { UserModel } from '../models/user.model';
import { IUserRepository } from '../repositories/user.repository';
import { GetUserUseCase } from './get-user.use-case';

const makeActor = (overrides: Partial<AuthenticatedUser>): AuthenticatedUser => ({
  sub: overrides.sub ?? 'actor',
  tenantId: overrides.tenantId ?? 'tenant-1',
  branchId: overrides.branchId ?? null,
  role: overrides.role ?? Role.SUPER_ADMIN,
});

describe('GetUserUseCase', () => {
  let users: jest.Mocked<IUserRepository>;
  let useCase: GetUserUseCase;

  beforeEach(() => {
    users = {
      create: jest.fn(),
      findById: jest.fn(),
      findByIdAnyTenant: jest.fn(),
      findByEmail: jest.fn(),
      findByEmailGlobal: jest.fn(),
      list: jest.fn(),
      update: jest.fn(),
      disable: jest.fn(),
      recordLogin: jest.fn(),
    };
    useCase = new GetUserUseCase(users);
  });

  it('returns target when SUPER_ADMIN', async () => {
    users.findById.mockResolvedValue(
      new UserModel('u-target', 'tenant-1', null, 'a@b.test', 'h', 'A', Role.STUDENT, 'ACTIVE', null, new Date(), new Date()),
    );
    const r = await useCase.execute({
      actor: makeActor({ role: Role.SUPER_ADMIN }),
      id: 'u-target',
    });
    expect(r.id).toBe('u-target');
  });

  it('STUDENT can read only own profile', async () => {
    users.findById.mockResolvedValue(
      new UserModel('u-target', 'tenant-1', null, 'a@b.test', 'h', 'A', Role.STUDENT, 'ACTIVE', null, new Date(), new Date()),
    );
    await expect(
      useCase.execute({
        actor: makeActor({ sub: 'u-other', role: Role.STUDENT }),
        id: 'u-target',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws 404 when user not in tenant', async () => {
    users.findById.mockResolvedValue(null);
    await expect(
      useCase.execute({ actor: makeActor({ role: Role.SUPER_ADMIN }), id: 'u-target' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
