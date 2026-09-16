import { Module, forwardRef } from '@nestjs/common';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';
import { BridgeModule } from '../bridge/bridge.module';
import { DiditModule } from '../didit/didit.module';

@Module({
  // DiditModule no importa nada de la aplicación, así que no hace falta
  // forwardRef: no hay ciclo, a diferencia de BridgeModule.
  imports: [forwardRef(() => BridgeModule), DiditModule],
  controllers: [SuppliersController],
  providers: [SuppliersService],
  exports: [SuppliersService],
})
export class SuppliersModule {}
