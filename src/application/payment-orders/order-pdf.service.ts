import { Injectable } from '@nestjs/common';
import { PdfService } from '../../core/pdf/pdf.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { ProfilesService } from '../profiles/profiles.service';
import { WalletsService } from '../wallets/wallets.service';
import { ClientBankAccountsService } from '../client-bank-accounts/client-bank-accounts.service';
import { PaymentOrdersService } from './payment-orders.service';

/**
 * Arma el comprobante operativo en PDF de una orden.
 *
 * Vive fuera de los controladores porque lo consumen dos rutas con distinto
 * alcance de lectura: `/payment-orders/:id/pdf` (el cliente descarga su propia
 * orden) y `/admin/payment-orders/:id/pdf` (el staff descarga exactamente el
 * mismo documento para cualquier orden). El armado de datos es idéntico en
 * ambos casos: lo único que cambia es cómo se localiza la orden.
 */
@Injectable()
export class OrderPdfService {
  constructor(
    private readonly paymentOrdersService: PaymentOrdersService,
    private readonly suppliersService: SuppliersService,
    private readonly profilesService: ProfilesService,
    private readonly walletsService: WalletsService,
    private readonly clientBankAccountsService: ClientBankAccountsService,
    private readonly pdfService: PdfService,
  ) {}

  /**
   * @param orderId Orden a documentar.
   * @param requesterUserId Si viene, la orden solo se encuentra si pertenece a
   *   ese usuario (vista cliente). Si es `null`, se busca sin scoping —
   *   reservado para rutas ya protegidas por RolesGuard (staff/admin).
   */
  async buildOrderPdf(
    orderId: string,
    requesterUserId: string | null,
  ): Promise<Buffer> {
    const order = requesterUserId
      ? await this.paymentOrdersService.getOrderById(requesterUserId, orderId)
      : await this.paymentOrdersService.getOrderByIdForStaff(orderId);

    // Proveedor, wallet y cuenta bancaria se consultan siempre contra el dueño
    // de la orden (no contra quien pide el PDF): así el staff obtiene el mismo
    // documento que ve el cliente.
    let supplier = null;
    if (order.supplier_id) {
      try {
        supplier = await this.suppliersService.findOne(
          order.supplier_id,
          order.user_id,
        );
      } catch (e) {
        // Ignorar si no se encuentra
      }
    }

    const profile = await this.profilesService.findOne(order.user_id);
    const [phone, identity] = await Promise.all([
      this.profilesService.getClientPhone(order.user_id),
      this.profilesService.getClientIdentityForPdf(order.user_id),
    ]);
    const client = {
      id: profile.id,
      full_name: profile.full_name ?? null,
      email: profile.email,
      phone,
      identity_label: identity?.identity_label ?? null,
      identity_value: identity?.identity_value ?? null,
      country: identity?.country ?? null,
      is_company: identity?.is_company ?? false,
    };

    let clientWallet = null;
    if (order.wallet_id) {
      try {
        clientWallet = await this.walletsService.findOne(
          order.wallet_id,
          order.user_id,
        );
      } catch (e) {
        // Ignorar si no se encuentra
      }
    }

    // Cuenta bancaria BOB del cliente — para flujos de retiro a Bolivia y world_to_bolivia
    const needsBankAccount = [
      'bridge_wallet_to_fiat_bo',
      'world_to_bolivia',
    ].includes(order.flow_type);
    const clientBankAccount = needsBankAccount
      ? await this.clientBankAccountsService.findPrimary(order.user_id)
      : null;

    return this.pdfService.generatePaymentPdf(
      order,
      supplier,
      client,
      clientWallet,
      clientBankAccount,
    );
  }
}
