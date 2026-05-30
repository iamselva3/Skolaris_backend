import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import { authConfig } from '../../../shared/config/auth.config';
import { Role } from '../../../shared/common/enums/role.enum';
import { JwtPayload } from '../models/authenticated-user.model';

export interface SignedAccessToken {
  token: string;
  expiresAt: Date;
}

export interface SignedRefreshToken {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(authConfig.KEY) private readonly auth: ConfigType<typeof authConfig>,
  ) {}

  signAccessToken(input: {
    userId: string;
    tenantId: string;
    branchId: string | null;
    role: Role;
  }): SignedAccessToken {
    const payload: JwtPayload = {
      sub: input.userId,
      tenant_id: input.tenantId,
      branch_id: input.branchId,
      role: input.role,
    };
    const token = this.jwt.sign(payload, {
      secret: this.auth.accessSecret,
      expiresIn: this.auth.accessTtl,
    });
    const expiresAt = this.computeExpiry(this.auth.accessTtl);
    return { token, expiresAt };
  }

  issueRefreshToken(): SignedRefreshToken {
    const raw = randomBytes(48).toString('base64url');
    const tokenHash = this.hashRefreshToken(raw);
    const expiresAt = this.computeExpiry(this.auth.refreshTtl);
    return { token: raw, tokenHash, expiresAt };
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private computeExpiry(ttl: string): Date {
    const ms = this.parseDuration(ttl);
    return new Date(Date.now() + ms);
  }

  private parseDuration(ttl: string): number {
    const match = /^(\d+)(ms|s|m|h|d)$/.exec(ttl);
    if (!match) {
      throw new Error(`Invalid duration: ${ttl}`);
    }
    const n = Number(match[1]);
    switch (match[2]) {
      case 'ms':
        return n;
      case 's':
        return n * 1000;
      case 'm':
        return n * 60 * 1000;
      case 'h':
        return n * 60 * 60 * 1000;
      case 'd':
        return n * 24 * 60 * 60 * 1000;
      default:
        throw new Error(`Unsupported duration unit: ${match[2]}`);
    }
  }
}
