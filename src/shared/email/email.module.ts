import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { emailConfig } from '../config/email.config';
import { EMAIL_SERVICE } from './email.interface';
import { SmtpEmail } from './smtp.email';

@Global()
@Module({
  imports: [ConfigModule.forFeature(emailConfig)],
  providers: [SmtpEmail, { provide: EMAIL_SERVICE, useExisting: SmtpEmail }],
  exports: [EMAIL_SERVICE],
})
export class EmailModule {}
