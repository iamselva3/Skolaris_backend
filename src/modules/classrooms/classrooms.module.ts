import { Module } from '@nestjs/common';
import { ClassroomsController } from './controllers/classrooms.controller';
import { CLASSROOM_REPOSITORY } from './repositories/classroom.repository';
import { PrismaClassroomRepository } from './repositories/prisma-classroom.repository';
import { AddStudentsToClassroomUseCase } from './use-cases/add-students-to-classroom.use-case';
import { AssignMemberToClassroomUseCase } from './use-cases/assign-member-to-classroom.use-case';
import { CreateClassroomUseCase } from './use-cases/create-classroom.use-case';
import { DeleteClassroomUseCase } from './use-cases/delete-classroom.use-case';
import { GetClassroomUseCase } from './use-cases/get-classroom.use-case';
import { ListClassroomStudentsUseCase } from './use-cases/list-classroom-students.use-case';
import { ListClassroomTeachersUseCase } from './use-cases/list-classroom-teachers.use-case';
import { ListClassroomsUseCase } from './use-cases/list-classrooms.use-case';
import { GetClassroomFiltersUseCase } from './use-cases/get-classroom-filters.use-case';
import { RemoveStudentFromClassroomUseCase } from './use-cases/remove-student-from-classroom.use-case';
import { UpdateClassroomUseCase } from './use-cases/update-classroom.use-case';

@Module({
  controllers: [ClassroomsController],
  providers: [
    CreateClassroomUseCase,
    ListClassroomsUseCase,
    GetClassroomFiltersUseCase,
    GetClassroomUseCase,
    UpdateClassroomUseCase,
    DeleteClassroomUseCase,
    AddStudentsToClassroomUseCase,
    AssignMemberToClassroomUseCase,
    RemoveStudentFromClassroomUseCase,
    ListClassroomStudentsUseCase,
    ListClassroomTeachersUseCase,
    { provide: CLASSROOM_REPOSITORY, useClass: PrismaClassroomRepository },
  ],
  exports: [CLASSROOM_REPOSITORY, AssignMemberToClassroomUseCase],
})
export class ClassroomsModule {}
