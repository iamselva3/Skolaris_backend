export class ExamSectionModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly examId: string,
    public readonly name: string,
    public readonly position: number,
    public readonly timeLimitSeconds: number | null,
  ) {}
}
