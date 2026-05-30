import { registerAs } from '@nestjs/config';

export interface DatabaseConfig {
  url: string;
}

export const databaseConfig = registerAs<DatabaseConfig>('database', () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('Missing required env var: DATABASE_URL');
  }
  return { url };
});
