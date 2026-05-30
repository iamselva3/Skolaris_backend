export const EMAIL_SERVICE = Symbol('EMAIL_SERVICE');

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface IEmailService {
  send(message: EmailMessage): Promise<void>;
}
