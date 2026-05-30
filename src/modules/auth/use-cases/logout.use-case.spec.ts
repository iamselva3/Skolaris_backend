import { RefreshTokenModel } from '../models/refresh-token.model';
import { IRefreshTokenRepository } from '../repositories/refresh-token.repository';
import { TokenService } from '../services/token.service';
import { LogoutUseCase } from './logout.use-case';

describe('LogoutUseCase', () => {
  let refresh: jest.Mocked<IRefreshTokenRepository>;
  let tokens: jest.Mocked<TokenService>;
  let useCase: LogoutUseCase;

  beforeEach(() => {
    refresh = {
      create: jest.fn(),
      findByTokenHash: jest.fn(),
      revoke: jest.fn().mockResolvedValue(undefined),
      revokeAllForUser: jest.fn().mockResolvedValue(undefined),
    };
    tokens = {
      signAccessToken: jest.fn(),
      issueRefreshToken: jest.fn(),
      hashRefreshToken: jest.fn().mockReturnValue('hash'),
    } as unknown as jest.Mocked<TokenService>;
    useCase = new LogoutUseCase(refresh, tokens);
  });

  it('revokes the matching refresh token', async () => {
    refresh.findByTokenHash.mockResolvedValue(
      new RefreshTokenModel('rt-1', 'user-1', 'hash', new Date(Date.now() + 1000), null, new Date()),
    );
    await useCase.execute({ userId: 'user-1', refreshToken: 'raw' });
    expect(refresh.revoke).toHaveBeenCalledWith('rt-1');
    expect(refresh.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('falls back to revoking all when token does not belong to user', async () => {
    refresh.findByTokenHash.mockResolvedValue(
      new RefreshTokenModel('rt-1', 'other-user', 'hash', new Date(Date.now() + 1000), null, new Date()),
    );
    await useCase.execute({ userId: 'user-1', refreshToken: 'raw' });
    expect(refresh.revokeAllForUser).toHaveBeenCalledWith('user-1');
  });

  it('revokes all when no refresh token is provided', async () => {
    await useCase.execute({ userId: 'user-1' });
    expect(refresh.revokeAllForUser).toHaveBeenCalledWith('user-1');
  });
});
