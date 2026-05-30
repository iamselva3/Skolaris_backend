import { Decimal } from '@prisma/client/runtime/library';

export class ExamQuestionModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly examId: string,
    public readonly sectionId: string | null,
    public readonly questionId: string,
    public readonly position: number,
    public readonly marks: Decimal,
    public readonly negativeMarks: Decimal,
  ) {}
}
