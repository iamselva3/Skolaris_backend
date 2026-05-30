export class ClassroomModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly branchId: string,
    public readonly name: string,
    public readonly year: string | null,
    public readonly section: string | null,
    public readonly subject: string | null,
    public readonly createdBy: string,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}
}

export interface ClassroomWithCount {
  classroom: ClassroomModel;
  studentCount: number;
}
