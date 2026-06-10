import { Inject, Injectable } from '@nestjs/common';
import { PaginatedResponse } from '../../../shared/common/dtos/paginated-response.dto';
import { TenantModel } from '../models/tenant.model';
import { ITenantRepository, TENANT_REPOSITORY } from '../repositories/tenant.repository';

@Injectable()
export class ListTenantsUseCase {
  constructor(@Inject(TENANT_REPOSITORY) private readonly tenants: ITenantRepository) {}

  async execute(input: { limit: number; offset: number }): Promise<PaginatedResponse<TenantModel>> {
    const { data, total } = await this.tenants.list(input.limit, input.offset);
    return { data, meta: { total, limit: input.limit, offset: input.offset } };
  }
}
