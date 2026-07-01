import { Inject, Injectable } from '@nestjs/common';
import { PaginatedResponse } from '../../../shared/common/dtos/paginated-response.dto';
import { UserModel } from '../../users/models/user.model';
import { CLASSROOM_REPOSITORY, IClassroomRepository } from '../repositories/classroom.repository';

@Injectable()
export class ListClassroomTeachersUseCase {
  constructor(@Inject(CLASSROOM_REPOSITORY) private readonly classrooms: IClassroomRepository) {}

  async execute(input: {
    tenantId: string;
    classroomId: string;
    limit: number;
    offset: number;
  }): Promise<PaginatedResponse<UserModel>> {
    const { data, total } = await this.classrooms.listTeachers(
      input.tenantId,
      input.classroomId,
      input.limit,
      input.offset,
    );
    return { data, meta: { total, limit: input.limit, offset: input.offset } };
  }
}
