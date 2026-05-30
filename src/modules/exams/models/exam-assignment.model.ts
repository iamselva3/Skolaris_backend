export class ExamAssignmentModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly examId: string,
    public readonly classroomId: string | null,
    public readonly studentId: string | null,
  ) {}
}
