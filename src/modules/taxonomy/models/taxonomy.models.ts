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

// Chapter is the mid-level (child of Subject); Topic is the leaf (child of Chapter).
export class ChapterModel {
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

export class TopicModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly chapterId: string,
    public readonly name: string,
    public readonly position: number,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}
}
