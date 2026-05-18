import { Module } from '@nestjs/common';
import { PsavService } from './psav.service';

@Module({
  providers: [PsavService],
  exports: [PsavService],
})
export class PsavModule {}
