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
    classroomId?: string;
    q?: string;
    limit: number;
    offset: number;
  }): Promise<PaginatedResponse<StudentWithUser>> {
    const { data, total } = await this.students.list(input);
    return { data, meta: { total, limit: input.limit, offset: input.offset } };
  }
}
