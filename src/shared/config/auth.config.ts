import { registerAs } from '@nestjs/config';

export interface AuthConfig {
  accessSecret: string;
  accessTtl: string;
  refreshSecret: string;
  refreshTtl: string;
}

const required = (key: string): string => {
  const v = process.env[key];
  if (!v || v.length === 0) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return v;
};

export const authConfig = registerAs<AuthConfig>('auth', () => ({
  accessSecret: required('JWT_ACCESS_SECRET'),
  accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
  refreshSecret: required('JWT_REFRESH_SECRET'),
  refreshTtl: process.env.JWT_REFRESH_TTL ?? '7d',
}));
