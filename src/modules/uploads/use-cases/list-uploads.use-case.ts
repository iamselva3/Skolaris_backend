import { Inject, Injectable } from '@nestjs/common';
import { PaginatedResponse } from '../../../shared/common/dtos/paginated-response.dto';
import { UploadModel, UploadStatus } from '../models/upload.model';
import {
  IUploadRepository,
  UPLOAD_REPOSITORY,
} from '../repositories/upload.repository';

@Injectable()
export class ListUploadsUseCase {
  constructor(@Inject(UPLOAD_REPOSITORY) private readonly uploads: IUploadRepository) {}

  async execute(input: {
    tenantId: string;
    status?: UploadStatus;
    uploadedBy?: string;
    limit: number;
    offset: number;
  }): Promise<PaginatedResponse<UploadModel>> {
    const { data, total } = await this.uploads.list(input.tenantId, {
      status: input.status,
      uploadedBy: input.uploadedBy,
      limit: input.limit,
      offset: input.offset,
    });
    return { data, meta: { total, limit: input.limit, offset: input.offset } };
  }
}
