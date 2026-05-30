import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { IUserRepository } from '../../users/repositories/user.repository';
import { IStudentRepository } from '../repositories/student.repository';
import { CreateStudentUseCase } from './create-student.use-case';

describe('CreateStudentUseCase', () => {
  let students: jest.Mocked<IStudentRepository>;
  let users: jest.Mocked<IUserRepository>;
  let useCase: CreateStudentUseCase;

  beforeEach(() => {
    students = {
      createWithUser: jest.fn().mockResolvedValue({ student: {}, user: {} } as never),
      findById: jest.fn(),
      findByUserId: jest.fn(),
      list: jest.fn(),
      update: jest.fn(),
      disable: jest.fn(),
    };
    users = {
      create: jest.fn(),
      findById: jest.fn(),
      findByIdAnyTenant: jest.fn(),
      findByEmail: jest.fn().mockResolvedValue(null),
      findByEmailGlobal: jest.fn(),
      list: jest.fn(),
      update: jest.fn(),
      disable: jest.fn(),
      recordLogin: jest.fn(),
    };
    useCase = new CreateStudentUseCase(students, users);
  });

  it('SUPER_ADMIN can create a student in any branch', async () => {
    await useCase.execute({
      actor: { sub: 'a', tenantId: 't', branchId: null, role: Role.SUPER_ADMIN },
      email: 'x@y.test',
      name: 'X',
      password: 'Password1!',
      branchId: 'b-1',
    });
    expect(students.createWithUser).toHaveBeenCalled();
  });

  it('TEACHER can create a student in their own branch', async () => {
    await useCase.execute({
      actor: { sub: 'a', tenantId: 't', branchId: 'b-1', role: Role.TEACHER },
      email: 'x@y.test',
      name: 'X',
      password: 'Password1!',
      branchId: 'b-1',
    });
    expect(students.createWithUser).toHaveBeenCalled();
  });

  it('TEACHER cannot create a student in a different branch', async () => {
    await expect(
      useCase.execute({
        actor: { sub: 'a', tenantId: 't', branchId: 'b-1', role: Role.TEACHER },
        email: 'x@y.test',
        name: 'X',
        password: 'Password1!',
        branchId: 'b-other',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects duplicate email in tenant', async () => {
    users.findByEmail.mockResolvedValue({ id: 'existing' } as never);
    await expect(
      useCase.execute({
        actor: { sub: 'a', tenantId: 't', branchId: 'b-1', role: Role.SUPER_ADMIN },
        email: 'dup@y.test',
        name: 'X',
        password: 'Password1!',
        branchId: 'b-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
