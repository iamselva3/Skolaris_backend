import { Role } from '../../../shared/common/enums/role.enum';

export interface AuthenticatedUser {
  sub: string;
  tenantId: string;
  branchId: string | null;
  role: Role;
}

export interface JwtPayload {
  sub: string;
  tenant_id: string;
  branch_id: string | null;
  role: Role;
  iat?: number;
  exp?: number;
}
