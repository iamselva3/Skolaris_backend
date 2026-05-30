import { Module } from '@nestjs/common';
import { TenantsController } from './controllers/tenants.controller';
import { PrismaTenantRepository } from './repositories/prisma-tenant.repository';
import { TENANT_REPOSITORY } from './repositories/tenant.repository';
import { CreateTenantUseCase } from './use-cases/create-tenant.use-case';
import { GetTenantUseCase } from './use-cases/get-tenant.use-case';
import { ListTenantsUseCase } from './use-cases/list-tenants.use-case';
import { UpdateTenantUseCase } from './use-cases/update-tenant.use-case';

@Module({
  controllers: [TenantsController],
  providers: [
    CreateTenantUseCase,
    ListTenantsUseCase,
    GetTenantUseCase,
    UpdateTenantUseCase,
    { provide: TENANT_REPOSITORY, useClass: PrismaTenantRepository },
  ],
  exports: [TENANT_REPOSITORY],
})
export class TenantsModule {}
