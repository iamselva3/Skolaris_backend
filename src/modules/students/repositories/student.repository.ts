import { StudentModel } from '../models/student.model';
import { UserModel } from '../../users/models/user.model';

export const STUDENT_REPOSITORY = Symbol('STUDENT_REPOSITORY');

export interface CreateStudentInput {
  tenantId: string;
  branchId: string | null;
  classLabel?: string | null;
  rollNo?: string | null;
  parentContact?: string | null;
  user: {
    email: string;
    name: string;
    passwordHash: string;
  };
}

export interface UpdateStudentInput {
  classLabel?: string | null;
  rollNo?: string | null;
  parentContact?: string | null;
  branchId?: string | null;
}

export interface ListStudentsFilter {
  tenantId: string;
  branchId?: string;
  batch?: string;
  section?: string;
  subject?: string;
  q?: string;
  unallocated?: boolean;
  limit: number;
  offset: number;
}

export interface StudentWithUser {
  student: StudentModel;
  user: UserModel;
}

export interface IStudentRepository {
  createWithUser(input: CreateStudentInput): Promise<StudentWithUser>;
  findById(tenantId: string, id: string): Promise<StudentWithUser | null>;
  findByUserId(tenantId: string, userId: string): Promise<StudentWithUser | null>;
  list(filter: ListStudentsFilter): Promise<{ data: StudentWithUser[]; total: number }>;
  update(tenantId: string, id: string, input: UpdateStudentInput): Promise<StudentWithUser>;
  disable(tenantId: string, id: string): Promise<void>;
}
