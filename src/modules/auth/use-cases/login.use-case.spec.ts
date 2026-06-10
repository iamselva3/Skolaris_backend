import { UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { Role } from '../../../shared/common/enums/role.enum';
import { TenantModel } from '../../tenants/models/tenant.model';
import { ITenantRepository } from '../../tenants/repositories/tenant.repository';
import { UserModel } from '../../users/models/user.model';
import { IUserRepository } from '../../users/repositories/user.repository';
import { RefreshTokenModel } from '../models/refresh-token.model';
import { IRefreshTokenRepository } from '../repositories/refresh-token.repository';
import { TokenService } from '../services/token.service';
import { LoginUseCase } from './login.use-case';

const makeUser = (overrides: Partial<UserModel> = {}): UserModel => {
  const now = new Date();
  return new UserModel(
    overrides.id ?? 'user-1',
    overrides.tenantId ?? 'tenant-1',
    overrides.branchId ?? null,
    overrides.email ?? 'a@b.test',
    overrides.phone ?? null,
    overrides.passwordHash ?? 'hash',
    overrides.name ?? 'A',
    overrides.role ?? Role.TEACHER,
    overrides.status ?? 'ACTIVE',
    overrides.lastLoginAt ?? null,
    overrides.createdAt ?? now,
    overrides.updatedAt ?? now,
  );
};

describe('LoginUseCase', () => {
  let users: jest.Mocked<IUserRepository>;
  let tenants: jest.Mocked<ITenantRepository>;
  let refresh: jest.Mocked<IRefreshTokenRepository>;
  let tokens: jest.Mocked<TokenService>;
  let useCase: LoginUseCase;

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
      recordLogin: jest.fn().mockResolvedValue(undefined),
    };
    tenants = {
      createWithAdmin: jest.fn(),
      findById: jest.fn(),
      findBySlug: jest.fn(),
      list: jest.fn(),
      update: jest.fn(),
    };
    refresh = {
      create: jest
        .fn()
        .mockResolvedValue(
          new RefreshTokenModel(
            'rt-1',
            'user-1',
            'hash',
            new Date(Date.now() + 60_000),
            null,
            new Date(),
          ),
        ),
      findByTokenHash: jest.fn(),
      revoke: jest.fn(),
      revokeAllForUser: jest.fn(),
    };
    tokens = {
      signAccessToken: jest.fn().mockReturnValue({
        token: 'access-jwt',
        expiresAt: new Date(Date.now() + 60_000),
      }),
      issueRefreshToken: jest.fn().mockReturnValue({
        token: 'raw-refresh',
        tokenHash: 'hashed-refresh',
        expiresAt: new Date(Date.now() + 60_000),
      }),
      hashRefreshToken: jest.fn().mockReturnValue('hashed-refresh'),
    } as unknown as jest.Mocked<TokenService>;

    useCase = new LoginUseCase(users, tenants, refresh, tokens);
  });

  it('returns tokens on valid credentials (global email)', async () => {
    const password = 'Password1!';
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    users.findByEmailGlobal.mockResolvedValue(makeUser({ passwordHash: hash }));

    const result = await useCase.execute({ email: 'a@b.test', password });

    expect(result.accessToken).toBe('access-jwt');
    expect(result.refreshToken).toBe('raw-refresh');
    expect(refresh.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', tokenHash: 'hashed-refresh' }),
    );
    expect(users.recordLogin).toHaveBeenCalledWith('user-1');
  });

  it('looks up by tenant slug when provided', async () => {
    const password = 'Password1!';
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    tenants.findBySlug.mockResolvedValue(
      new TenantModel('tenant-1', 'Acme', 'acme', 'ACTIVE', new Date(), new Date()),
    );
    users.findByEmail.mockResolvedValue(makeUser({ passwordHash: hash }));

    await useCase.execute({ email: 'a@b.test', password, tenantSlug: 'acme' });

    expect(tenants.findBySlug).toHaveBeenCalledWith('acme');
    expect(users.findByEmail).toHaveBeenCalledWith('tenant-1', 'a@b.test');
    expect(users.findByEmailGlobal).not.toHaveBeenCalled();
  });

  it('throws 401 when user not found', async () => {
    users.findByEmailGlobal.mockResolvedValue(null);
    await expect(
      useCase.execute({ email: 'x@y.test', password: 'whatever1!' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws 401 when password is wrong', async () => {
    const hash = await argon2.hash('CorrectPassword1!', { type: argon2.argon2id });
    users.findByEmailGlobal.mockResolvedValue(makeUser({ passwordHash: hash }));
    await expect(
      useCase.execute({ email: 'a@b.test', password: 'WrongPassword1!' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws 401 when user is disabled', async () => {
    const hash = await argon2.hash('Password1!', { type: argon2.argon2id });
    users.findByEmailGlobal.mockResolvedValue(makeUser({ passwordHash: hash, status: 'DISABLED' }));
    await expect(
      useCase.execute({ email: 'a@b.test', password: 'Password1!' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
