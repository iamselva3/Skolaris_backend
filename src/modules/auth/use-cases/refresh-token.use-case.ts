import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthTokensResponse } from '../dtos/auth-response.dto';
import { IUserRepository, USER_REPOSITORY } from '../../users/repositories/user.repository';
import {
  IRefreshTokenRepository,
  REFRESH_TOKEN_REPOSITORY,
} from '../repositories/refresh-token.repository';
import { TokenService } from '../services/token.service';

@Injectable()
export class RefreshTokenUseCase {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: IRefreshTokenRepository,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    private readonly tokens: TokenService,
  ) {}

  async execute(rawToken: string): Promise<AuthTokensResponse> {
    if (!rawToken) {
      throw new UnauthorizedException('Refresh token required');
    }
    const tokenHash = this.tokens.hashRefreshToken(rawToken);
    const stored = await this.refreshTokens.findByTokenHash(tokenHash);
    if (!stored || !stored.isActive()) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.users.findByIdAnyTenant(stored.userId);
    if (!user || !user.isActive()) {
      await this.refreshTokens.revoke(stored.id);
      throw new UnauthorizedException('User no longer active');
    }

    // Rotate: revoke old, issue new.
    await this.refreshTokens.revoke(stored.id);

    const access = this.tokens.signAccessToken({
      userId: user.id,
      tenantId: user.tenantId,
      branchId: user.branchId,
      role: user.role,
    });
    const refresh = this.tokens.issueRefreshToken();
    await this.refreshTokens.create({
      userId: user.id,
      tokenHash: refresh.tokenHash,
      expiresAt: refresh.expiresAt,
    });

    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshTokenExpiresAt: refresh.expiresAt.toISOString(),
    };
  }
}
