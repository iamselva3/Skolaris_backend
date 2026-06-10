import { Inject, Injectable } from '@nestjs/common';
import { IStudentRepository, STUDENT_REPOSITORY } from '../repositories/student.repository';

@Injectable()
export class DisableStudentUseCase {
  constructor(@Inject(STUDENT_REPOSITORY) private readonly students: IStudentRepository) {}

  execute(input: { tenantId: string; id: string }): Promise<void> {
    return this.students.disable(input.tenantId, input.id);
  }
}
