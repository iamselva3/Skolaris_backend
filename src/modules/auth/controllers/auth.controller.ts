import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Public } from '../decorators/public.decorator';
import { AuthTokensResponse, CurrentUserResponse } from '../dtos/auth-response.dto';
import { LoginDto } from '../dtos/login.dto';
import { RefreshTokenDto } from '../dtos/refresh-token.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { AuthenticatedUser } from '../models/authenticated-user.model';
import { GetCurrentUserUseCase } from '../use-cases/get-current-user.use-case';
import { LoginUseCase } from '../use-cases/login.use-case';
import { LogoutUseCase } from '../use-cases/logout.use-case';
import { RefreshTokenUseCase } from '../use-cases/refresh-token.use-case';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly loginUseCase: LoginUseCase,
    private readonly refreshTokenUseCase: RefreshTokenUseCase,
    private readonly logoutUseCase: LogoutUseCase,
    private readonly getCurrentUserUseCase: GetCurrentUserUseCase,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto): Promise<{ data: AuthTokensResponse }> {
    const tokens = await this.loginUseCase.execute({
      email: dto.email,
      password: dto.password,
      tenantSlug: dto.tenantSlug,
    });
    return { data: tokens };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshTokenDto): Promise<{ data: AuthTokensResponse }> {
    const tokens = await this.refreshTokenUseCase.execute(dto.refreshToken);
    return { data: tokens };
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: Partial<RefreshTokenDto>,
  ): Promise<void> {
    await this.logoutUseCase.execute({
      userId: user.sub,
      refreshToken: dto.refreshToken,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser): Promise<{ data: CurrentUserResponse }> {
    const me = await this.getCurrentUserUseCase.execute({
      userId: user.sub,
      tenantId: user.tenantId,
    });
    return { data: me };
  }
}
