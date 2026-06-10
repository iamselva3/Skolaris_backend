import { Inject, Injectable } from '@nestjs/common';
import { PaginatedResponse } from '../../../shared/common/dtos/paginated-response.dto';
import { StudentWithUser } from '../../students/repositories/student.repository';
import { CLASSROOM_REPOSITORY, IClassroomRepository } from '../repositories/classroom.repository';

@Injectable()
export class ListClassroomStudentsUseCase {
  constructor(@Inject(CLASSROOM_REPOSITORY) private readonly classrooms: IClassroomRepository) {}

  async execute(input: {
    tenantId: string;
    classroomId: string;
    limit: number;
    offset: number;
  }): Promise<PaginatedResponse<StudentWithUser>> {
    const { data, total } = await this.classrooms.listStudents(
      input.tenantId,
      input.classroomId,
      input.limit,
      input.offset,
    );
    return { data, meta: { total, limit: input.limit, offset: input.offset } };
  }
}
