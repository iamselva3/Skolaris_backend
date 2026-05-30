import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { Transporter } from 'nodemailer';
import { emailConfig } from '../config/email.config';
import { EmailMessage, IEmailService } from './email.interface';

@Injectable()
export class SmtpEmail implements IEmailService, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SmtpEmail.name);
  private transporter!: Transporter;

  constructor(@Inject(emailConfig.KEY) private readonly cfg: ConfigType<typeof emailConfig>) {}

  onModuleInit(): void {
    this.transporter = nodemailer.createTransport({
      host: this.cfg.host,
      port: this.cfg.port,
      secure: this.cfg.secure,
      auth:
        this.cfg.user && this.cfg.pass
          ? { user: this.cfg.user, pass: this.cfg.pass }
          : undefined,
    });
    this.logger.log(
      `SMTP transport ready: ${this.cfg.host}:${this.cfg.port} from=${this.cfg.from}`,
    );
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.cfg.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text ?? this.stripHtml(message.html),
    });
  }

  onModuleDestroy(): void {
    if (this.transporter) {
      this.transporter.close();
    }
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]*>/g, '').trim();
  }
}
