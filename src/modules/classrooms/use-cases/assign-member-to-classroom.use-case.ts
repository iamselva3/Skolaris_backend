import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { ClassroomModel } from '../models/classroom.model';
import { CLASSROOM_REPOSITORY, IClassroomRepository } from '../repositories/classroom.repository';
import { normalizeClassroomIdentity } from './normalize-classroom';

/**
 * The classroom block supplied when creating a student or a teacher. All four
 * levels are required together (Academic Year → Discipline → Batch → Section); the
 * hierarchy is mandatory and levels cannot be skipped.
 */
export interface ClassroomAssignment {
  year: string;
  discipline: string;
  batch: string;
  section: string;
}

export interface AssignMemberToClassroomInput {
  actor: AuthenticatedUser;
  branchId: string;
  assignment: ClassroomAssignment;
  studentId?: string;
  teacherId?: string;
}

/**
 * Single reusable entry point for "create student/teacher, then attach to a
 * classroom in one step". It does NOT fork the classroom domain — it delegates to
 * the existing classroom repository (find-or-create + attach), so the Classroom
 * module stays the single source of truth and no duplicate classrooms are created.
 */
@Injectable()
export class AssignMemberToClassroomUseCase {
  constructor(@Inject(CLASSROOM_REPOSITORY) private readonly classrooms: IClassroomRepository) {}

  async execute(input: AssignMemberToClassroomInput): Promise<ClassroomModel> {
    const { actor, branchId, assignment } = input;

    if (!branchId) {
      throw new BadRequestException('A branch is required to assign a classroom');
    }
    if (actor.role === Role.TEACHER && (!actor.branchId || branchId !== actor.branchId)) {
      throw new ForbiddenException('Teachers can only assign classrooms in their own branch');
    }

    // Selection order is mandatory — every level must be present and non-blank.
    const year = assignment.year?.trim();
    const discipline = assignment.discipline?.trim();
    const batch = assignment.batch?.trim();
    const section = assignment.section?.trim();
    if (!year) throw new BadRequestException('Academic year is required');
    if (!discipline) throw new BadRequestException('Discipline is required');
    if (!batch) throw new BadRequestException('Batch is required');
    if (!section) throw new BadRequestException('Section is required');

    const identity = normalizeClassroomIdentity({
      name: batch,
      year,
      section,
      subject: discipline,
    });

    const classroom = await this.classrooms.findOrCreate({
      tenantId: actor.tenantId,
      branchId,
      name: identity.name,
      year: identity.year,
      section: identity.section,
      subject: identity.subject,
      createdBy: actor.sub,
    });

    if (input.studentId) {
      await this.classrooms.addStudents(actor.tenantId, classroom.id, [input.studentId]);
    }
    if (input.teacherId) {
      await this.classrooms.addTeachers(actor.tenantId, classroom.id, [input.teacherId]);
    }

    return classroom;
  }
}
