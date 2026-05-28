import { Module } from '@nestjs/common';
import { PsavService } from './psav.service';
import { AdminModule } from '../admin/admin.module';

@Module({
  imports: [AdminModule],
  providers: [PsavService],
  exports: [PsavService],
})
export class PsavModule {}
