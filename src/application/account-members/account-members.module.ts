import { Module } from '@nestjs/common';
import { AccountMembersController } from './account-members.controller';
import { AccountMembersService } from './account-members.service';
import { InvitationThrottleService } from './invitation-throttle.service';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [EmailModule],
  controllers: [AccountMembersController],
  providers: [AccountMembersService, InvitationThrottleService],
  exports: [AccountMembersService],
})
export class AccountMembersModule {}
