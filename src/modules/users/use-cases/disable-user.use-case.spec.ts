import { NotFoundException } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { UserModel } from '../models/user.model';
import { IUserRepository } from '../repositories/user.repository';
import { DisableUserUseCase } from './disable-user.use-case';

describe('DisableUserUseCase', () => {
  let users: jest.Mocked<IUserRepository>;
  let useCase: DisableUserUseCase;

  beforeEach(() => {
    users = {
      create: jest.fn(),
      findById: jest.fn(),
      findByIdAnyTenant: jest.fn(),
      findByEmail: jest.fn(),
      findByEmailGlobal: jest.fn(),
      list: jest.fn(),
      update: jest.fn(),
      disable: jest.fn().mockResolvedValue(undefined),
      recordLogin: jest.fn(),
    };
    useCase = new DisableUserUseCase(users);
  });

  it('disables existing user', async () => {
    users.findById.mockResolvedValue(
      new UserModel('u', 't', null, 'a@b.test', 'h', 'A', Role.STUDENT, 'ACTIVE', null, new Date(), new Date()),
    );
    await useCase.execute({ tenantId: 't', id: 'u' });
    expect(users.disable).toHaveBeenCalledWith('t', 'u');
  });

  it('throws 404 when missing', async () => {
    users.findById.mockResolvedValue(null);
    await expect(useCase.execute({ tenantId: 't', id: 'u' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
