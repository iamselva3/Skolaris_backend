import { registerAs } from '@nestjs/config';

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  corsOrigins: string[];
}

const parseOrigins = (raw: string | undefined, nodeEnv: string): string[] => {
  if (raw && raw.length > 0) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // Dev defaults: Vite dev server. Production must set CORS_ORIGINS explicitly.
  return nodeEnv === 'production' ? [] : ['http://localhost:5173'];
};

export const appConfig = registerAs<AppConfig>('app', () => {
  const nodeEnv = (process.env.NODE_ENV as AppConfig['nodeEnv']) ?? 'development';
  return {
    nodeEnv,
    port: Number(process.env.PORT ?? 3000),
    corsOrigins: parseOrigins(process.env.CORS_ORIGINS, nodeEnv),
  };
});
