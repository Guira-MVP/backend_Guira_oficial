import { Module } from '@nestjs/common';
import {
  ClientBankAccountsController,
  AdminClientBankAccountsController,
} from './client-bank-accounts.controller';
import { ClientBankAccountsService } from './client-bank-accounts.service';

@Module({
  controllers: [
    ClientBankAccountsController,
    AdminClientBankAccountsController,
  ],
  providers: [ClientBankAccountsService],
  exports: [ClientBankAccountsService],
})
export class ClientBankAccountsModule {}
