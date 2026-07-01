import { ClassroomModel, ClassroomWithCount } from '../models/classroom.model';
import { UserModel } from '../../users/models/user.model';

export interface ClassroomResponse {
  id: string;
  tenantId: string;
  branchId: string;
  name: string;
  year: string | null;
  section: string | null;
  subject: string | null;
  createdBy: string;
  teacherIds?: string[];
  studentCount?: number;
  createdAt: string;
  updatedAt: string;
}

export const toClassroomResponse = (
  c: ClassroomModel,
  studentCount?: number,
): ClassroomResponse => ({
  id: c.id,
  tenantId: c.tenantId,
  branchId: c.branchId,
  name: c.name,
  year: c.year,
  section: c.section,
  subject: c.subject,
  createdBy: c.createdBy,
  teacherIds: c.teacherIds,
  studentCount,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

export const toClassroomResponseFromWithCount = (cwc: ClassroomWithCount): ClassroomResponse =>
  toClassroomResponse(cwc.classroom, cwc.studentCount);

/** A teacher allocated to a classroom — safe public fields only (no passwordHash). */
export interface ClassroomTeacherResponse {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: string;
}

export const toClassroomTeacherResponse = (u: UserModel): ClassroomTeacherResponse => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  status: u.status,
});
