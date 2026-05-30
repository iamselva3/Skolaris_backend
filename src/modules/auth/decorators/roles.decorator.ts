import { SetMetadata } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
