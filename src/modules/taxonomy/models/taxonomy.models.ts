export class ProgramModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly code: string,
    public readonly name: string,
    public readonly isActive: boolean,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}
}

export class SubjectModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly programId: string,
    public readonly name: string,
    public readonly isActive: boolean,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
    public readonly program?: { id: string; code: string; name: string } | null,
  ) {}
}

export class TopicModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly subjectId: string,
    public readonly name: string,
    public readonly position: number,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}
}

export class ChapterModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly topicId: string,
    public readonly name: string,
    public readonly position: number,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}
}
