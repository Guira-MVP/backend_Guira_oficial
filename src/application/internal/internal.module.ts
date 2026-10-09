import { Module } from '@nestjs/common';
import { InternalController } from './internal.controller';
import { NewUserAlertService } from './new-user-alert.service';

@Module({
  controllers: [InternalController],
  providers: [NewUserAlertService],
})
export class InternalModule {}
