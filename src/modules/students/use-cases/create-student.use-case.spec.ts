import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { AssignMemberToClassroomUseCase } from '../../classrooms/use-cases/assign-member-to-classroom.use-case';
import { IUserRepository } from '../../users/repositories/user.repository';
import { IStudentRepository } from '../repositories/student.repository';
import { CreateStudentUseCase } from './create-student.use-case';

describe('CreateStudentUseCase', () => {
  let students: jest.Mocked<IStudentRepository>;
  let users: jest.Mocked<IUserRepository>;
  let assign: jest.Mocked<AssignMemberToClassroomUseCase>;
  let useCase: CreateStudentUseCase;

  beforeEach(() => {
    students = {
      createWithUser: jest
        .fn()
        .mockResolvedValue({ student: { id: 'stu-1' }, user: {} } as never),
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
    assign = { execute: jest.fn() } as unknown as jest.Mocked<AssignMemberToClassroomUseCase>;
    useCase = new CreateStudentUseCase(students, users, assign);
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

  it('does NOT touch classrooms when no classroom block is supplied', async () => {
    await useCase.execute({
      actor: { sub: 'a', tenantId: 't', branchId: 'b-1', role: Role.SUPER_ADMIN },
      email: 'x@y.test',
      name: 'X',
      password: 'Password1!',
      branchId: 'b-1',
    });
    expect(assign.execute).not.toHaveBeenCalled();
  });

  it('assigns the new student to a classroom when a classroom block is supplied', async () => {
    await useCase.execute({
      actor: { sub: 'a', tenantId: 't', branchId: 'b-1', role: Role.SUPER_ADMIN },
      email: 'x@y.test',
      name: 'X',
      password: 'Password1!',
      branchId: 'b-1',
      classroom: { year: '2025-2026', discipline: 'NEET', batch: 'Morning Batch', section: 'A' },
    });
    expect(assign.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        branchId: 'b-1',
        studentId: 'stu-1',
        assignment: { year: '2025-2026', discipline: 'NEET', batch: 'Morning Batch', section: 'A' },
      }),
    );
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
