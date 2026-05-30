import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  IStudentRepository,
  STUDENT_REPOSITORY,
} from '../../students/repositories/student.repository';

/**
 * STUDENT-role JWTs carry `sub = user.id`. Most attempt logic keys off
 * `student.id` (the Student row). This service resolves user → student
 * within a tenant and caches lookups per request only when needed.
 */
@Injectable()
export class StudentResolverService {
  constructor(@Inject(STUDENT_REPOSITORY) private readonly students: IStudentRepository) {}

  async requireStudentIdForUser(tenantId: string, userId: string): Promise<string> {
    const found = await this.students.findByUserId(tenantId, userId);
    if (!found) {
      throw new NotFoundException('Student profile not found for this user');
    }
    return found.student.id;
  }
}
