export class BranchModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly name: string,
    public readonly deletedAt: Date | null,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}
}
