export type TenantStatus = 'ACTIVE' | 'SUSPENDED';

export class TenantModel {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly slug: string,
    public readonly status: TenantStatus,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}
}
