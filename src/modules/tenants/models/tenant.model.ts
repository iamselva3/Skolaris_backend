export type TenantStatus = 'ACTIVE' | 'SUSPENDED';

/** Hard floor/ceiling the super-admin may configure the violation limit to. */
export const MIN_TENANT_VIOLATION_LIMIT = 1;
export const MAX_TENANT_VIOLATION_LIMIT = 50;

export class TenantModel {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly slug: string,
    public readonly status: TenantStatus,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
    // Tenant-wide max anti-cheat violations before an attempt auto-submits.
    // Defaults to 6 so existing constructions (and tests) stay valid.
    public readonly examViolationLimit: number = 6,
  ) {}
}
