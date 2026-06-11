import { ChapterModel, ProgramModel, SubjectModel, TopicModel } from '../models/taxonomy.models';

export const TAXONOMY_REPOSITORY = Symbol('TAXONOMY_REPOSITORY');

export interface ListSubjectsFilter {
  tenantId: string;
  programId?: string;
  isActive?: boolean;
}

export interface ITaxonomyRepository {
  /* programs */
  listPrograms(tenantId: string): Promise<ProgramModel[]>;
  getProgram(tenantId: string, id: string): Promise<ProgramModel | null>;
  getProgramByCode(tenantId: string, code: string): Promise<ProgramModel | null>;
  createProgram(input: { tenantId: string; code: string; name: string }): Promise<ProgramModel>;
  updateProgram(
    tenantId: string,
    id: string,
    patch: { name?: string; isActive?: boolean },
  ): Promise<ProgramModel>;

  /* subjects */
  listSubjects(filter: ListSubjectsFilter): Promise<SubjectModel[]>;
  getSubject(tenantId: string, id: string): Promise<SubjectModel | null>;
  createSubject(input: {
    tenantId: string;
    programId: string;
    name: string;
  }): Promise<SubjectModel>;
  updateSubject(
    tenantId: string,
    id: string,
    patch: { name?: string; isActive?: boolean },
  ): Promise<SubjectModel>;

  /* teacher_subjects */
  listSubjectsForTeacher(tenantId: string, userId: string): Promise<SubjectModel[]>;
  assignTeacherSubjects(input: {
    tenantId: string;
    userId: string;
    subjectIds: string[];
  }): Promise<void>;

  /* chapters (mid-level, child of Subject) */
  listChapters(tenantId: string, subjectId?: string): Promise<ChapterModel[]>;
  getChapter(tenantId: string, id: string): Promise<ChapterModel | null>;
  createChapter(input: {
    tenantId: string;
    subjectId: string;
    name: string;
    position?: number;
  }): Promise<ChapterModel>;
  updateChapter(
    tenantId: string,
    id: string,
    patch: { name?: string; position?: number },
  ): Promise<ChapterModel>;
  deleteChapter(tenantId: string, id: string): Promise<void>;

  /* topics (leaf, child of Chapter) */
  listTopics(tenantId: string, chapterId?: string): Promise<TopicModel[]>;
  getTopic(tenantId: string, id: string): Promise<TopicModel | null>;
  createTopic(input: {
    tenantId: string;
    chapterId: string;
    name: string;
    position?: number;
  }): Promise<TopicModel>;
  updateTopic(
    tenantId: string,
    id: string,
    patch: { name?: string; position?: number },
  ): Promise<TopicModel>;
  deleteTopic(tenantId: string, id: string): Promise<void>;
}
