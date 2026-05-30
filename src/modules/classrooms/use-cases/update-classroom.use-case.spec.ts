import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { ClassroomModel } from '../models/classroom.model';
import { IClassroomRepository } from '../repositories/classroom.repository';
import { UpdateClassroomUseCase } from './update-classroom.use-case';

const cls = (overrides: Partial<ClassroomModel> = {}): ClassroomModel =>
  new ClassroomModel(
    overrides.id ?? 'c-1',
    overrides.tenantId ?? 't-1',
    overrides.branchId ?? 'b-1',
    overrides.name ?? 'Name',
    null,
    null,
    null,
    overrides.createdBy ?? 'creator-1',
    new Date(),
    new Date(),
  );

describe('UpdateClassroomUseCase', () => {
  let repo: jest.Mocked<IClassroomRepository>;
  let useCase: UpdateClassroomUseCase;

  beforeEach(() => {
    repo = {
      create: jest.fn(),
      findById: jest.fn(),
      findWithCount: jest.fn(),
      list: jest.fn(),
      update: jest.fn().mockImplementation(async (_t, id, input) =>
        cls({ id, name: input.name ?? 'Name' }),
      ),
      remove: jest.fn(),
      addStudents: jest.fn(),
      removeStudent: jest.fn(),
      listStudents: jest.fn(),
    };
    useCase = new UpdateClassroomUseCase(repo);
  });

  it('SUPER_ADMIN can edit any classroom', async () => {
    repo.findById.mockResolvedValue(cls({ createdBy: 'someone-else' }));
    const r = await useCase.execute({
      actor: { sub: 'admin', tenantId: 't-1', branchId: null, role: Role.SUPER_ADMIN },
      id: 'c-1',
      name: 'New',
    });
    expect(r.name).toBe('New');
  });

  it('TEACHER can edit a classroom they created', async () => {
    repo.findById.mockResolvedValue(cls({ createdBy: 'teacher-1' }));
    const r = await useCase.execute({
      actor: { sub: 'teacher-1', tenantId: 't-1', branchId: 'b-1', role: Role.TEACHER },
      id: 'c-1',
      name: 'New',
    });
    expect(r.name).toBe('New');
  });

  it('TEACHER cannot edit a classroom created by someone else', async () => {
    repo.findById.mockResolvedValue(cls({ createdBy: 'other-teacher' }));
    await expect(
      useCase.execute({
        actor: { sub: 'teacher-1', tenantId: 't-1', branchId: 'b-1', role: Role.TEACHER },
        id: 'c-1',
        name: 'New',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws 404 when classroom is missing', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(
      useCase.execute({
        actor: { sub: 'admin', tenantId: 't-1', branchId: null, role: Role.SUPER_ADMIN },
        id: 'c-1',
        name: 'New',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 400 when no fields provided', async () => {
    repo.findById.mockResolvedValue(cls({ createdBy: 'admin' }));
    await expect(
      useCase.execute({
        actor: { sub: 'admin', tenantId: 't-1', branchId: null, role: Role.SUPER_ADMIN },
        id: 'c-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
