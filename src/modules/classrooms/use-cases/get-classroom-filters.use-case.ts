import { Inject, Injectable } from '@nestjs/common';
import { CLASSROOM_REPOSITORY, IClassroomRepository } from '../repositories/classroom.repository';

@Injectable()
export class GetClassroomFiltersUseCase {
  constructor(@Inject(CLASSROOM_REPOSITORY) private readonly classrooms: IClassroomRepository) {}

  async execute(input: {
    tenantId: string;
    branchId?: string;
    subject?: string;
    name?: string;
  }): Promise<{ names: string[]; sections: string[]; years: string[]; subjects: string[] }> {
    return this.classrooms.getFilters(input.tenantId, input.branchId, {
      subject: input.subject,
      name: input.name,
    });
  }
}
