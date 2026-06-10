import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { UserModel } from '../models/user.model';
import { IUserRepository } from '../repositories/user.repository';
import { CreateUserUseCase } from './create-user.use-case';

const makeActor = (overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser => ({
  sub: overrides.sub ?? 'actor-1',
  tenantId: overrides.tenantId ?? 'tenant-1',
  branchId: overrides.branchId ?? null,
  role: overrides.role ?? Role.SUPER_ADMIN,
});

describe('CreateUserUseCase', () => {
  let users: jest.Mocked<IUserRepository>;
  let useCase: CreateUserUseCase;

  beforeEach(() => {
    users = {
      create: jest
        .fn()
        .mockImplementation(
          async (i) =>
            new UserModel(
              'u-new',
              i.tenantId,
              i.branchId ?? null,
              i.email,
              null,
              i.passwordHash,
              i.name,
              i.role,
              'ACTIVE',
              null,
              new Date(),
              new Date(),
            ),
        ),
      findById: jest.fn(),
      findByIdAnyTenant: jest.fn(),
      findByEmail: jest.fn().mockResolvedValue(null),
      findByEmailGlobal: jest.fn(),
      list: jest.fn(),
      update: jest.fn(),
      disable: jest.fn(),
      recordLogin: jest.fn(),
    };
    useCase = new CreateUserUseCase(users);
  });

  it('SUPER_ADMIN can create any role', async () => {
    const r = await useCase.execute({
      actor: makeActor({ role: Role.SUPER_ADMIN }),
      email: 'a@b.test',
      name: 'A',
      password: 'Password1!',
      role: Role.TEACHER,
    });
    expect(r.role).toBe(Role.TEACHER);
    const call = users.create.mock.calls[0][0];
    await expect(argon2.verify(call.passwordHash, 'Password1!')).resolves.toBe(true);
  });

  it('TEACHER can create STUDENT in their own branch', async () => {
    const r = await useCase.execute({
      actor: makeActor({ role: Role.TEACHER, branchId: 'br-1' }),
      email: 'a@b.test',
      name: 'A',
      password: 'Password1!',
      role: Role.STUDENT,
      branchId: 'br-1',
    });
    expect(r.role).toBe(Role.STUDENT);
  });

  it('TEACHER cannot create a TEACHER', async () => {
    await expect(
      useCase.execute({
        actor: makeActor({ role: Role.TEACHER, branchId: 'br-1' }),
        email: 'a@b.test',
        name: 'A',
        password: 'Password1!',
        role: Role.TEACHER,
        branchId: 'br-1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('TEACHER cannot create STUDENT in another branch', async () => {
    await expect(
      useCase.execute({
        actor: makeActor({ role: Role.TEACHER, branchId: 'br-1' }),
        email: 'a@b.test',
        name: 'A',
        password: 'Password1!',
        role: Role.STUDENT,
        branchId: 'br-2',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('TEACHER must supply branchId', async () => {
    await expect(
      useCase.execute({
        actor: makeActor({ role: Role.TEACHER, branchId: 'br-1' }),
        email: 'a@b.test',
        name: 'A',
        password: 'Password1!',
        role: Role.STUDENT,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('STUDENT cannot create users', async () => {
    await expect(
      useCase.execute({
        actor: makeActor({ role: Role.STUDENT }),
        email: 'a@b.test',
        name: 'A',
        password: 'Password1!',
        role: Role.STUDENT,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects duplicate email within tenant', async () => {
    users.findByEmail.mockResolvedValue(
      new UserModel(
        'x',
        'tenant-1',
        null,
        'a@b.test',
        null,
        'h',
        'X',
        Role.STUDENT,
        'ACTIVE',
        null,
        new Date(),
        new Date(),
      ),
    );
    await expect(
      useCase.execute({
        actor: makeActor({ role: Role.SUPER_ADMIN }),
        email: 'a@b.test',
        name: 'A',
        password: 'Password1!',
        role: Role.STUDENT,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
