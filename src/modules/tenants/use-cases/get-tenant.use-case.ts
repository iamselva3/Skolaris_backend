import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TenantModel } from '../models/tenant.model';
import { ITenantRepository, TENANT_REPOSITORY } from '../repositories/tenant.repository';

@Injectable()
export class GetTenantUseCase {
  constructor(@Inject(TENANT_REPOSITORY) private readonly tenants: ITenantRepository) {}

  async execute(id: string): Promise<TenantModel> {
    const tenant = await this.tenants.findById(id);
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    return tenant;
  }
}
