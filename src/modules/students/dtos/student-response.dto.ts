import { StudentWithUser } from '../repositories/student.repository';

export interface StudentResponse {
  id: string;
  tenantId: string;
  userId: string;
  branchId: string | null;
  email: string;
  name: string;
  classLabel: string | null;
  rollNo: string | null;
  parentContact: string | null;
  status: 'ACTIVE' | 'DISABLED';
  createdAt: string;
  updatedAt: string;
  batch?: string | null;
  section?: string | null;
  subject?: string | null;
}

export const toStudentResponse = ({ student, user }: StudentWithUser): StudentResponse => ({
  id: student.id,
  tenantId: student.tenantId,
  userId: student.userId,
  branchId: student.branchId,
  email: user.email,
  name: user.name,
  classLabel: student.classLabel,
  rollNo: student.rollNo,
  parentContact: student.parentContact,
  status: user.status,
  createdAt: student.createdAt.toISOString(),
  updatedAt: student.updatedAt.toISOString(),
  batch: student.batch,
  section: student.section,
  subject: student.subject,
});
