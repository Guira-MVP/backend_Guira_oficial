import { Module } from '@nestjs/common';
import { FeesController, AdminFeesController } from './fees.controller';
import { FeesService } from './fees.service';

@Module({
  controllers: [FeesController, AdminFeesController],
  providers: [FeesService],
  exports: [FeesService],
})
export class FeesModule {}
