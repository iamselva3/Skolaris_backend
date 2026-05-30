import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../models/authenticated-user.model';
import { RolesGuard } from './roles.guard';

const ctx = (user?: AuthenticatedUser): ExecutionContext =>
  ({
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  }) as unknown as ExecutionContext;

describe('RolesGuard', () => {
  it('allows when no @Roles metadata is set', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(ctx({ sub: 'x', tenantId: 't', branchId: null, role: Role.STUDENT }))).toBe(true);
  });

  it('allows when user role matches', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue([Role.SUPER_ADMIN, Role.TEACHER]),
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(ctx({ sub: 'x', tenantId: 't', branchId: null, role: Role.TEACHER }))).toBe(true);
  });

  it('throws 403 when role does not match', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue([Role.SUPER_ADMIN]),
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(() =>
      guard.canActivate(ctx({ sub: 'x', tenantId: 't', branchId: null, role: Role.STUDENT })),
    ).toThrow(ForbiddenException);
  });

  it('throws 403 when no user', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue([Role.SUPER_ADMIN]),
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(ctx(undefined))).toThrow(ForbiddenException);
  });
});
