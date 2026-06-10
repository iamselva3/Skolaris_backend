import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ClassroomWithCount } from '../models/classroom.model';
import { CLASSROOM_REPOSITORY, IClassroomRepository } from '../repositories/classroom.repository';

@Injectable()
export class GetClassroomUseCase {
  constructor(@Inject(CLASSROOM_REPOSITORY) private readonly classrooms: IClassroomRepository) {}

  async execute(input: { tenantId: string; id: string }): Promise<ClassroomWithCount> {
    const found = await this.classrooms.findWithCount(input.tenantId, input.id);
    if (!found) throw new NotFoundException('Classroom not found');
    return found;
  }
}
