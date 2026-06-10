import { RefreshTokenModel } from '../models/refresh-token.model';

export const REFRESH_TOKEN_REPOSITORY = Symbol('REFRESH_TOKEN_REPOSITORY');

export interface IRefreshTokenRepository {
  create(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<RefreshTokenModel>;

  findByTokenHash(tokenHash: string): Promise<RefreshTokenModel | null>;

  revoke(id: string): Promise<void>;

  revokeAllForUser(userId: string): Promise<void>;
}
