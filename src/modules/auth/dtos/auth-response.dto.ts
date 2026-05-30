import { Role } from '../../../shared/common/enums/role.enum';

export interface AuthTokensResponse {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
}

export interface CurrentUserResponse {
  id: string;
  tenantId: string;
  branchId: string | null;
  email: string;
  name: string;
  role: Role;
}
