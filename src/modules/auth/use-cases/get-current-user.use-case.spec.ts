import { NotFoundException } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { UserModel } from '../../users/models/user.model';
import { IUserRepository } from '../../users/repositories/user.repository';
import { GetCurrentUserUseCase } from './get-current-user.use-case';

describe('GetCurrentUserUseCase', () => {
  let users: jest.Mocked<IUserRepository>;
  let useCase: GetCurrentUserUseCase;

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
    useCase = new GetCurrentUserUseCase(users);
  });

  it('returns user profile when found', async () => {
    users.findById.mockResolvedValue(
      new UserModel(
        'u',
        't',
        'b',
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
    );
    const result = await useCase.execute({ userId: 'u', tenantId: 't' });
    expect(result.id).toBe('u');
    expect(result.role).toBe(Role.STUDENT);
  });

  it('throws 404 when user is missing', async () => {
    users.findById.mockResolvedValue(null);
    await expect(useCase.execute({ userId: 'u', tenantId: 't' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
