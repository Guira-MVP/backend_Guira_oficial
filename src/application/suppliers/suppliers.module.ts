import { Module, forwardRef } from '@nestjs/common';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';
import { BridgeModule } from '../bridge/bridge.module';

@Module({
  imports: [forwardRef(() => BridgeModule)],
  controllers: [SuppliersController],
  providers: [SuppliersService],
  exports: [SuppliersService],
})
export class SuppliersModule {}
