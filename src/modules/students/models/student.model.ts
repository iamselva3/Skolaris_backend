export class StudentModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly branchId: string | null,
    public readonly classLabel: string | null,
    public readonly rollNo: string | null,
    public readonly parentContact: string | null,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}
}
