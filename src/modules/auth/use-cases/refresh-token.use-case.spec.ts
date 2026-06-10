import { UnauthorizedException } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { UserModel } from '../../users/models/user.model';
import { IUserRepository } from '../../users/repositories/user.repository';
import { RefreshTokenModel } from '../models/refresh-token.model';
import { IRefreshTokenRepository } from '../repositories/refresh-token.repository';
import { TokenService } from '../services/token.service';
import { RefreshTokenUseCase } from './refresh-token.use-case';

describe('RefreshTokenUseCase', () => {
  let refresh: jest.Mocked<IRefreshTokenRepository>;
  let users: jest.Mocked<IUserRepository>;
  let tokens: jest.Mocked<TokenService>;
  let useCase: RefreshTokenUseCase;

  beforeEach(() => {
    refresh = {
      create: jest
        .fn()
        .mockResolvedValue(
          new RefreshTokenModel(
            'rt-2',
            'user-1',
            'new-hash',
            new Date(Date.now() + 60_000),
            null,
            new Date(),
          ),
        ),
      findByTokenHash: jest.fn(),
      revoke: jest.fn().mockResolvedValue(undefined),
      revokeAllForUser: jest.fn(),
    };
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
    tokens = {
      signAccessToken: jest.fn().mockReturnValue({ token: 'access-jwt', expiresAt: new Date() }),
      issueRefreshToken: jest
        .fn()
        .mockReturnValue({ token: 'new-raw', tokenHash: 'new-hash', expiresAt: new Date() }),
      hashRefreshToken: jest.fn().mockReturnValue('old-hash'),
    } as unknown as jest.Mocked<TokenService>;
    useCase = new RefreshTokenUseCase(refresh, users, tokens);
  });

  it('rotates token on success', async () => {
    refresh.findByTokenHash.mockResolvedValue(
      new RefreshTokenModel(
        'rt-1',
        'user-1',
        'old-hash',
        new Date(Date.now() + 60_000),
        null,
        new Date(),
      ),
    );
    users.findByIdAnyTenant.mockResolvedValue(
      new UserModel(
        'user-1',
        'tenant-1',
        null,
        'a@b.test',
        null,
        'h',
        'A',
        Role.TEACHER,
        'ACTIVE',
        null,
        new Date(),
        new Date(),
      ),
    );

    const result = await useCase.execute('raw-token');

    expect(refresh.revoke).toHaveBeenCalledWith('rt-1');
    expect(refresh.create).toHaveBeenCalled();
    expect(result.refreshToken).toBe('new-raw');
  });

  it('rejects missing token', async () => {
    await expect(useCase.execute('')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects unknown token', async () => {
    refresh.findByTokenHash.mockResolvedValue(null);
    await expect(useCase.execute('raw')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects revoked token', async () => {
    refresh.findByTokenHash.mockResolvedValue(
      new RefreshTokenModel(
        'rt-1',
        'user-1',
        'old-hash',
        new Date(Date.now() + 60_000),
        new Date(),
        new Date(),
      ),
    );
    await expect(useCase.execute('raw')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects expired token', async () => {
    refresh.findByTokenHash.mockResolvedValue(
      new RefreshTokenModel(
        'rt-1',
        'user-1',
        'old-hash',
        new Date(Date.now() - 1000),
        null,
        new Date(),
      ),
    );
    await expect(useCase.execute('raw')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('revokes token and rejects if user is disabled', async () => {
    refresh.findByTokenHash.mockResolvedValue(
      new RefreshTokenModel(
        'rt-1',
        'user-1',
        'old-hash',
        new Date(Date.now() + 60_000),
        null,
        new Date(),
      ),
    );
    users.findByIdAnyTenant.mockResolvedValue(
      new UserModel(
        'user-1',
        'tenant-1',
        null,
        'a@b.test',
        null,
        'h',
        'A',
        Role.TEACHER,
        'DISABLED',
        null,
        new Date(),
        new Date(),
      ),
    );
    await expect(useCase.execute('raw')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(refresh.revoke).toHaveBeenCalledWith('rt-1');
  });
});
