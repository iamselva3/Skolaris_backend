import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { authConfig } from '../../../shared/config/auth.config';
import { AuthenticatedUser, JwtPayload } from '../models/authenticated-user.model';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    @Inject(authConfig.KEY)
    auth: ConfigType<typeof authConfig>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: auth.accessSecret,
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (!payload.sub || !payload.tenant_id || !payload.role) {
      throw new UnauthorizedException('Invalid token payload');
    }
    return {
      sub: payload.sub,
      tenantId: payload.tenant_id,
      branchId: payload.branch_id ?? null,
      role: payload.role,
    };
  }
}
