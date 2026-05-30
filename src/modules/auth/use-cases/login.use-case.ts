import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuthTokensResponse } from '../dtos/auth-response.dto';
import {
  IUserRepository,
  USER_REPOSITORY,
} from '../../users/repositories/user.repository';
import {
  ITenantRepository,
  TENANT_REPOSITORY,
} from '../../tenants/repositories/tenant.repository';
import {
  IRefreshTokenRepository,
  REFRESH_TOKEN_REPOSITORY,
} from '../repositories/refresh-token.repository';
import { TokenService } from '../services/token.service';

export interface LoginInput {
  email: string;
  password: string;
  tenantSlug?: string;
}

@Injectable()
export class LoginUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(TENANT_REPOSITORY) private readonly tenants: ITenantRepository,
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: IRefreshTokenRepository,
    private readonly tokens: TokenService,
  ) {}

  async execute(input: LoginInput): Promise<AuthTokensResponse> {
    const user = await this.resolveUser(input);
    if (!user || !user.isActive()) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordOk = await argon2.verify(user.passwordHash, input.password);
    if (!passwordOk) {
      throw new UnauthorizedException('Invalid credentials');
    }

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
    await this.users.recordLogin(user.id);

    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshTokenExpiresAt: refresh.expiresAt.toISOString(),
    };
  }

  private async resolveUser(input: LoginInput) {
    if (input.tenantSlug) {
      const tenant = await this.tenants.findBySlug(input.tenantSlug);
      if (!tenant) return null;
      return this.users.findByEmail(tenant.id, input.email);
    }
    return this.users.findByEmailGlobal(input.email);
  }
}
