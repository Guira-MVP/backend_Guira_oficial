import { Module } from '@nestjs/common';
import { AccountMembersController } from './account-members.controller';
import { AccountMembersService } from './account-members.service';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [EmailModule],
  controllers: [AccountMembersController],
  providers: [AccountMembersService],
  exports: [AccountMembersService],
})
export class AccountMembersModule {}
