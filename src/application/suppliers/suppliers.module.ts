import { Module, forwardRef } from '@nestjs/common';
import { SuppliersController } from './suppliers.controller';
import { AdminSuppliersController } from './admin-suppliers.controller';
import { SuppliersService } from './suppliers.service';
import { SwiftSuppliersService } from './swift/swift-suppliers.service';
import { BridgeModule } from '../bridge/bridge.module';
import { DiditModule } from '../didit/didit.module';
import { TazapayModule } from '../tazapay/tazapay.module';

@Module({
  // DiditModule y TazapayModule no importan nada de la aplicación, así que no
  // hace falta forwardRef: no hay ciclo, a diferencia de BridgeModule.
  imports: [forwardRef(() => BridgeModule), DiditModule, TazapayModule],
  controllers: [SuppliersController, AdminSuppliersController],
  providers: [SuppliersService, SwiftSuppliersService],
  exports: [SuppliersService],
})
export class SuppliersModule {}
