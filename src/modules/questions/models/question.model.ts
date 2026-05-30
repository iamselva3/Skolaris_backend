import { Difficulty, QuestionType } from './question-type.enum';

export class QuestionOptionModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly questionId: string,
    public readonly label: string,
    public readonly isCorrect: boolean,
    public readonly position: number,
  ) {}
}

export class QuestionModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly createdBy: string,
    public readonly sourceUploadId: string | null,
    public readonly type: QuestionType,
    public readonly payload: Record<string, unknown>,
    public readonly programId: string | null,
    public readonly subjectId: string | null,
    public readonly topicId: string | null,
    public readonly chapterId: string | null,
    public readonly subject: string | null,
    public readonly topic: string | null,
    public readonly difficulty: Difficulty,
    public readonly isActive: boolean,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}
}

export interface QuestionWithOptions {
  question: QuestionModel;
  options: QuestionOptionModel[];
}
