import { ClassroomModel, ClassroomWithCount } from '../models/classroom.model';

export interface ClassroomResponse {
  id: string;
  tenantId: string;
  branchId: string;
  name: string;
  year: string | null;
  section: string | null;
  subject: string | null;
  createdBy: string;
  studentCount?: number;
  createdAt: string;
  updatedAt: string;
}

export const toClassroomResponse = (c: ClassroomModel, studentCount?: number): ClassroomResponse => ({
  id: c.id,
  tenantId: c.tenantId,
  branchId: c.branchId,
  name: c.name,
  year: c.year,
  section: c.section,
  subject: c.subject,
  createdBy: c.createdBy,
  studentCount,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

export const toClassroomResponseFromWithCount = (cwc: ClassroomWithCount): ClassroomResponse =>
  toClassroomResponse(cwc.classroom, cwc.studentCount);
