import { Inject, Injectable } from '@nestjs/common';
import { PaginatedResponse } from '../../../shared/common/dtos/paginated-response.dto';
import {
  IStudentRepository,
  STUDENT_REPOSITORY,
  StudentWithUser,
} from '../repositories/student.repository';

@Injectable()
export class ListStudentsUseCase {
  constructor(@Inject(STUDENT_REPOSITORY) private readonly students: IStudentRepository) {}

  async execute(input: {
    tenantId: string;
    branchId?: string;
    batch?: string;
    section?: string;
    subject?: string;
    q?: string;
    unallocated?: boolean;
    limit: number;
    offset: number;
  }): Promise<PaginatedResponse<StudentWithUser>> {
    const { data, total } = await this.students.list({
      tenantId: input.tenantId,
      branchId: input.branchId,
      batch: input.batch,
      section: input.section,
      subject: input.subject,
      q: input.q,
      unallocated: input.unallocated,
      limit: input.limit,
      offset: input.offset,
    });
    return { data, meta: { total, limit: input.limit, offset: input.offset } };
  }
}
