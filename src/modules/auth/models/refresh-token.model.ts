export class RefreshTokenModel {
  constructor(
    public readonly id: string,
    public readonly userId: string,
    public readonly tokenHash: string,
    public readonly expiresAt: Date,
    public readonly revokedAt: Date | null,
    public readonly createdAt: Date,
  ) {}

  isActive(now: Date = new Date()): boolean {
    return this.revokedAt === null && this.expiresAt.getTime() > now.getTime();
  }
}
