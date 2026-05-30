import { Injectable } from '@nestjs/common';
import { RefreshToken as PrismaRefreshToken } from '@prisma/client';
import { PrismaService } from '../../../shared/database/prisma.service';
import { RefreshTokenModel } from '../models/refresh-token.model';
import { IRefreshTokenRepository } from './refresh-token.repository';

@Injectable()
export class PrismaRefreshTokenRepository implements IRefreshTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<RefreshTokenModel> {
    const row = await this.prisma.refreshToken.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      },
    });
    return this.toModel(row);
  }

  async findByTokenHash(tokenHash: string): Promise<RefreshTokenModel | null> {
    const row = await this.prisma.refreshToken.findFirst({ where: { tokenHash } });
    return row ? this.toModel(row) : null;
  }

  async revoke(id: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private toModel(r: PrismaRefreshToken): RefreshTokenModel {
    return new RefreshTokenModel(
      r.id,
      r.userId,
      r.tokenHash,
      r.expiresAt,
      r.revokedAt,
      r.createdAt,
    );
  }
}
