import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { authConfig } from '../../shared/config/auth.config';
import { UsersModule } from '../users/users.module';
import { TenantsModule } from '../tenants/tenants.module';
import { AuthController } from './controllers/auth.controller';
import {
  IRefreshTokenRepository,
  REFRESH_TOKEN_REPOSITORY,
} from './repositories/refresh-token.repository';
import { PrismaRefreshTokenRepository } from './repositories/prisma-refresh-token.repository';
import { TokenService } from './services/token.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { GetCurrentUserUseCase } from './use-cases/get-current-user.use-case';
import { LoginUseCase } from './use-cases/login.use-case';
import { LogoutUseCase } from './use-cases/logout.use-case';
import { RefreshTokenUseCase } from './use-cases/refresh-token.use-case';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule.forFeature(authConfig)],
      inject: [authConfig.KEY],
      useFactory: (auth: ConfigType<typeof authConfig>) => ({
        secret: auth.accessSecret,
        signOptions: { expiresIn: auth.accessTtl },
      }),
    }),
    UsersModule,
    TenantsModule,
  ],
  controllers: [AuthController],
  providers: [
    JwtStrategy,
    TokenService,
    LoginUseCase,
    RefreshTokenUseCase,
    LogoutUseCase,
    GetCurrentUserUseCase,
    {
      provide: REFRESH_TOKEN_REPOSITORY,
      useClass: PrismaRefreshTokenRepository,
    } satisfies { provide: symbol; useClass: new (...args: never[]) => IRefreshTokenRepository },
  ],
  exports: [TokenService],
})
export class AuthModule {}
