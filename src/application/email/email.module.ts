import { Global, Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { ZeptoMailClient } from './zeptomail.client';

@Global()
@Module({
  providers: [ZeptoMailClient, EmailService],
  exports: [EmailService],
})
export class EmailModule {}
