import { Module } from '@nestjs/common';
import { LedgerController, AdminLedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';

@Module({
  controllers: [LedgerController, AdminLedgerController],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
