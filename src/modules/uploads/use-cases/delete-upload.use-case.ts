import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { IObjectStorage, OBJECT_STORAGE } from '../../../shared/storage/object-storage.interface';
import { IUploadRepository, UPLOAD_REPOSITORY } from '../repositories/upload.repository';

@Injectable()
export class DeleteUploadUseCase {
  constructor(
    @Inject(UPLOAD_REPOSITORY) private readonly uploads: IUploadRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: IObjectStorage,
  ) {}

  async execute(input: { actor: AuthenticatedUser; id: string }): Promise<void> {
    const upload = await this.uploads.findById(input.actor.tenantId, input.id);
    if (!upload) throw new NotFoundException('Upload not found');
    if (input.actor.role === Role.TEACHER && upload.uploadedBy !== input.actor.sub) {
      throw new ForbiddenException('Teachers can only delete their own uploads');
    }
    if (upload.status !== 'PENDING_UPLOAD' && upload.status !== 'FAILED') {
      throw new ConflictException(
        `Cannot delete upload in status ${upload.status}; only PENDING_UPLOAD or FAILED are deletable`,
      );
    }
    await this.storage.deleteObject(upload.storageKey);
    await this.uploads.remove(input.actor.tenantId, input.id);
  }
}
