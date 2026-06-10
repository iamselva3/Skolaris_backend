import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TenantModel, TenantStatus } from '../models/tenant.model';
import { ITenantRepository, TENANT_REPOSITORY } from '../repositories/tenant.repository';

export interface UpdateTenantInput {
  id: string;
  name?: string;
  status?: TenantStatus;
}

@Injectable()
export class UpdateTenantUseCase {
  constructor(@Inject(TENANT_REPOSITORY) private readonly tenants: ITenantRepository) {}

  async execute(input: UpdateTenantInput): Promise<TenantModel> {
    const existing = await this.tenants.findById(input.id);
    if (!existing) {
      throw new NotFoundException('Tenant not found');
    }
    return this.tenants.update(input.id, { name: input.name, status: input.status });
  }
}
