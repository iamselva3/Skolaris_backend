import { registerAs } from '@nestjs/config';

export interface EmailConfig {
  host: string;
  port: number;
  from: string;
  user: string | null;
  pass: string | null;
  secure: boolean;
}

export const emailConfig = registerAs<EmailConfig>('email', () => {
  const host = process.env.SMTP_HOST;
  if (!host) {
    throw new Error('Missing required env var: SMTP_HOST');
  }
  return {
    host,
    port: Number(process.env.SMTP_PORT ?? 1025),
    from: process.env.SMTP_FROM ?? 'no-reply@skolaris.local',
    user: process.env.SMTP_USER || null,
    pass: process.env.SMTP_PASS || null,
    secure: process.env.SMTP_SECURE === 'true',
  };
});
