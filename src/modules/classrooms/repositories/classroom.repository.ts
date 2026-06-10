import { ClassroomModel, ClassroomWithCount } from '../models/classroom.model';
import { StudentWithUser } from '../../students/repositories/student.repository';

export const CLASSROOM_REPOSITORY = Symbol('CLASSROOM_REPOSITORY');

export interface CreateClassroomInput {
  tenantId: string;
  branchId: string;
  name: string;
  year?: string | null;
  section?: string | null;
  subject?: string | null;
  createdBy: string;
  teacherIds?: string[];
}

export interface UpdateClassroomInput {
  name?: string;
  year?: string | null;
  section?: string | null;
  subject?: string | null;
  createdBy?: string;
  teacherIds?: string[];
}

export interface IClassroomRepository {
  create(input: CreateClassroomInput): Promise<ClassroomModel>;
  findById(tenantId: string, id: string): Promise<ClassroomModel | null>;
  findByUniqueAttributes(
    tenantId: string,
    branchId: string,
    name: string,
    year?: string | null,
    section?: string | null,
  ): Promise<ClassroomModel | null>;
  findWithCount(tenantId: string, id: string): Promise<ClassroomWithCount | null>;
  list(
    tenantId: string,
    filters: {
      branchId?: string;
      createdBy?: string;
      name?: string;
      section?: string;
      year?: string;
      subject?: string;
      search?: string;
      limit: number;
      offset: number;
    },
  ): Promise<{ data: ClassroomWithCount[]; total: number }>;
  getFilters(
    tenantId: string,
    branchId?: string,
  ): Promise<{ names: string[]; sections: string[]; years: string[]; subjects: string[] }>;
  update(tenantId: string, id: string, input: UpdateClassroomInput): Promise<ClassroomModel>;
  remove(tenantId: string, id: string): Promise<void>;

  addStudents(
    tenantId: string,
    classroomId: string,
    studentIds: string[],
  ): Promise<{ added: string[]; alreadyMember: string[] }>;
  removeStudent(tenantId: string, classroomId: string, studentId: string): Promise<boolean>;
  listStudents(
    tenantId: string,
    classroomId: string,
    limit: number,
    offset: number,
  ): Promise<{ data: StudentWithUser[]; total: number }>;
}
