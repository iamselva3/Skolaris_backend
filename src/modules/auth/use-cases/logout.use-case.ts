import { Inject, Injectable } from '@nestjs/common';
import {
  IRefreshTokenRepository,
  REFRESH_TOKEN_REPOSITORY,
} from '../repositories/refresh-token.repository';
import { TokenService } from '../services/token.service';

@Injectable()
export class LogoutUseCase {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: IRefreshTokenRepository,
    private readonly tokens: TokenService,
  ) {}

  async execute(input: { userId: string; refreshToken?: string }): Promise<void> {
    if (input.refreshToken) {
      const tokenHash = this.tokens.hashRefreshToken(input.refreshToken);
      const stored = await this.refreshTokens.findByTokenHash(tokenHash);
      if (stored && stored.userId === input.userId) {
        await this.refreshTokens.revoke(stored.id);
        return;
      }
    }
    // Fallback: revoke every active refresh token for this user.
    await this.refreshTokens.revokeAllForUser(input.userId);
  }
}
