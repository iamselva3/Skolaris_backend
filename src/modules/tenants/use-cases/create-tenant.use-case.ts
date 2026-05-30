import { ConflictException, Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import {
  ITenantRepository,
  TENANT_REPOSITORY,
} from '../repositories/tenant.repository';

export interface CreateTenantInput {
  name: string;
  slug: string;
  admin: { email: string; name: string; password: string };
}

export interface CreateTenantResult {
  id: string;
  name: string;
  slug: string;
  admin: { id: string; email: string };
}

@Injectable()
export class CreateTenantUseCase {
  constructor(@Inject(TENANT_REPOSITORY) private readonly tenants: ITenantRepository) {}

  async execute(input: CreateTenantInput): Promise<CreateTenantResult> {
    const existing = await this.tenants.findBySlug(input.slug);
    if (existing) {
      throw new ConflictException(`Tenant with slug "${input.slug}" already exists`);
    }
    const passwordHash = await argon2.hash(input.admin.password, { type: argon2.argon2id });
    const { tenant, admin } = await this.tenants.createWithAdmin({
      name: input.name,
      slug: input.slug,
      admin: {
        email: input.admin.email,
        name: input.admin.name,
        passwordHash,
      },
    });
    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      admin: { id: admin.id, email: admin.email },
    };
  }
}
