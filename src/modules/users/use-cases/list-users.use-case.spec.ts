import { Role } from '../../../shared/common/enums/role.enum';
import { UserModel } from '../models/user.model';
import { IUserRepository } from '../repositories/user.repository';
import { ListUsersUseCase } from './list-users.use-case';

describe('ListUsersUseCase', () => {
  it('passes filters and wraps pagination', async () => {
    const users: jest.Mocked<IUserRepository> = {
      create: jest.fn(),
      findById: jest.fn(),
      findByIdAnyTenant: jest.fn(),
      findByEmail: jest.fn(),
      findByEmailGlobal: jest.fn(),
      list: jest.fn().mockResolvedValue({
        data: [
          new UserModel(
            'u',
            't',
            null,
            'a@b.test',
            null,
            'h',
            'A',
            Role.STUDENT,
            'ACTIVE',
            null,
            new Date(),
            new Date(),
          ),
        ],
        total: 1,
      }),
      update: jest.fn(),
      disable: jest.fn(),
      recordLogin: jest.fn(),
    };
    const useCase = new ListUsersUseCase(users);
    const r = await useCase.execute({
      tenantId: 't',
      role: Role.STUDENT,
      branchId: 'br',
      limit: 5,
      offset: 10,
    });
    expect(users.list).toHaveBeenCalledWith({
      tenantId: 't',
      role: Role.STUDENT,
      branchId: 'br',
      limit: 5,
      offset: 10,
    });
    expect(r.meta).toEqual({ total: 1, limit: 5, offset: 10 });
  });
});
