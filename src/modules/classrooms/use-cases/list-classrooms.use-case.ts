import { Inject, Injectable } from '@nestjs/common';
import { PaginatedResponse } from '../../../shared/common/dtos/paginated-response.dto';
import { ClassroomWithCount } from '../models/classroom.model';
import {
  CLASSROOM_REPOSITORY,
  IClassroomRepository,
} from '../repositories/classroom.repository';

@Injectable()
export class ListClassroomsUseCase {
  constructor(
    @Inject(CLASSROOM_REPOSITORY) private readonly classrooms: IClassroomRepository,
  ) {}

  async execute(input: {
    tenantId: string;
    branchId?: string;
    createdBy?: string;
    limit: number;
    offset: number;
  }): Promise<PaginatedResponse<ClassroomWithCount>> {
    const { data, total } = await this.classrooms.list(input.tenantId, {
      branchId: input.branchId,
      createdBy: input.createdBy,
      limit: input.limit,
      offset: input.offset,
    });
    return { data, meta: { total, limit: input.limit, offset: input.offset } };
  }
}
