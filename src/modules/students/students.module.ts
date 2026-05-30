import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { StudentsController } from './controllers/students.controller';
import { PrismaStudentRepository } from './repositories/prisma-student.repository';
import { STUDENT_REPOSITORY } from './repositories/student.repository';
import { CreateStudentUseCase } from './use-cases/create-student.use-case';
import { DisableStudentUseCase } from './use-cases/disable-student.use-case';
import { GetStudentUseCase } from './use-cases/get-student.use-case';
import { ListStudentsUseCase } from './use-cases/list-students.use-case';
import { UpdateStudentUseCase } from './use-cases/update-student.use-case';

@Module({
  imports: [UsersModule],
  controllers: [StudentsController],
  providers: [
    CreateStudentUseCase,
    ListStudentsUseCase,
    GetStudentUseCase,
    UpdateStudentUseCase,
    DisableStudentUseCase,
    { provide: STUDENT_REPOSITORY, useClass: PrismaStudentRepository },
  ],
  exports: [STUDENT_REPOSITORY],
})
export class StudentsModule {}
