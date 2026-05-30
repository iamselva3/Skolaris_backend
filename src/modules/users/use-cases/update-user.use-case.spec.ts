import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { UserModel } from '../models/user.model';
import { IUserRepository } from '../repositories/user.repository';
import { UpdateUserUseCase } from './update-user.use-case';

const makeActor = (o: Partial<AuthenticatedUser>): AuthenticatedUser => ({
  sub: o.sub ?? 'actor',
  tenantId: o.tenantId ?? 'tenant-1',
  branchId: o.branchId ?? null,
  role: o.role ?? Role.SUPER_ADMIN,
});

const makeTarget = (role: Role = Role.STUDENT) =>
  new UserModel('u-target', 'tenant-1', null, 'a@b.test', 'h', 'A', role, 'ACTIVE', null, new Date(), new Date());

describe('UpdateUserUseCase', () => {
  let users: jest.Mocked<IUserRepository>;
  let useCase: UpdateUserUseCase;

  beforeEach(() => {
    users = {
      create: jest.fn(),
      findById: jest.fn(),
      findByIdAnyTenant: jest.fn(),
      findByEmail: jest.fn(),
      findByEmailGlobal: jest.fn(),
      list: jest.fn(),
      update: jest.fn().mockImplementation(async (_t, id, input) =>
        new UserModel(
          id,
          'tenant-1',
          input.branchId ?? null,
          'a@b.test',
          input.passwordHash ?? 'h',
          input.name ?? 'A',
          Role.STUDENT,
          input.status ?? 'ACTIVE',
          null,
          new Date(),
          new Date(),
        ),
      ),
      disable: jest.fn(),
      recordLogin: jest.fn(),
    };
    useCase = new UpdateUserUseCase(users);
  });

  it('allows self to update name', async () => {
    users.findById.mockResolvedValue(makeTarget());
    const r = await useCase.execute({
      actor: makeActor({ sub: 'u-target', role: Role.STUDENT }),
      id: 'u-target',
      name: 'NewName',
    });
    expect(r.name).toBe('NewName');
  });

  it('forbids non-self non-admin update', async () => {
    users.findById.mockResolvedValue(makeTarget());
    await expect(
      useCase.execute({
        actor: makeActor({ sub: 'someone-else', role: Role.TEACHER }),
        id: 'u-target',
        name: 'X',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('forbids non-admin from changing branch', async () => {
    users.findById.mockResolvedValue(makeTarget());
    await expect(
      useCase.execute({
        actor: makeActor({ sub: 'u-target', role: Role.STUDENT }),
        id: 'u-target',
        branchId: 'br-new',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('forbids non-admin from changing status', async () => {
    users.findById.mockResolvedValue(makeTarget());
    await expect(
      useCase.execute({
        actor: makeActor({ sub: 'u-target', role: Role.STUDENT }),
        id: 'u-target',
        status: 'DISABLED',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('SUPER_ADMIN can change status', async () => {
    users.findById.mockResolvedValue(makeTarget());
    const r = await useCase.execute({
      actor: makeActor({ role: Role.SUPER_ADMIN }),
      id: 'u-target',
      status: 'DISABLED',
    });
    expect(r.status).toBe('DISABLED');
  });

  it('throws 404 when user missing', async () => {
    users.findById.mockResolvedValue(null);
    await expect(
      useCase.execute({ actor: makeActor({ role: Role.SUPER_ADMIN }), id: 'u-x', name: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 400 when no fields', async () => {
    users.findById.mockResolvedValue(makeTarget());
    await expect(
      useCase.execute({ actor: makeActor({ sub: 'u-target', role: Role.STUDENT }), id: 'u-target' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
