import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { ClassroomModel } from '../models/classroom.model';
import {
  CLASSROOM_REPOSITORY,
  IClassroomRepository,
  UpdateClassroomInput as RepoUpdate,
} from '../repositories/classroom.repository';

export interface UpdateClassroomInput {
  actor: AuthenticatedUser;
  id: string;
  name?: string;
  year?: string | null;
  section?: string | null;
  subject?: string | null;
}

@Injectable()
export class UpdateClassroomUseCase {
  constructor(
    @Inject(CLASSROOM_REPOSITORY) private readonly classrooms: IClassroomRepository,
  ) {}

  async execute(input: UpdateClassroomInput): Promise<ClassroomModel> {
    const target = await this.classrooms.findById(input.actor.tenantId, input.id);
    if (!target) throw new NotFoundException('Classroom not found');

    if (input.actor.role === Role.TEACHER && target.createdBy !== input.actor.sub) {
      throw new ForbiddenException('Teachers can only edit classrooms they created');
    }

    const repoInput: RepoUpdate = {};
    if (input.name !== undefined) repoInput.name = input.name;
    if (input.year !== undefined) repoInput.year = input.year;
    if (input.section !== undefined) repoInput.section = input.section;
    if (input.subject !== undefined) repoInput.subject = input.subject;
    if (Object.keys(repoInput).length === 0) {
      throw new BadRequestException('No fields to update');
    }
    return this.classrooms.update(input.actor.tenantId, input.id, repoInput);
  }
}
