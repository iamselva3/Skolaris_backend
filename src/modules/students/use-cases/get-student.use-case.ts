import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  IStudentRepository,
  STUDENT_REPOSITORY,
  StudentWithUser,
} from '../repositories/student.repository';

@Injectable()
export class GetStudentUseCase {
  constructor(@Inject(STUDENT_REPOSITORY) private readonly students: IStudentRepository) {}

  async execute(input: { tenantId: string; id: string }): Promise<StudentWithUser> {
    const found = await this.students.findById(input.tenantId, input.id);
    if (!found) {
      throw new NotFoundException('Student not found');
    }
    return found;
  }
}
