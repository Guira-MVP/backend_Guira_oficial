import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as Sentry from '@sentry/nestjs';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/dto/notifications.dto';
import { DiditWalletScreeningService } from './didit-wallet-screening.service';
import {
  WALLET_RESCREENING_BATCH_SETTING_KEY,
  WALLET_RESCREENING_DEFAULT_BATCH_SIZE,
  WALLET_RESCREENING_DEFAULT_INTERVAL_DAYS,
  WALLET_RESCREENING_ENABLED_SETTING_KEY,
  WALLET_RESCREENING_INTERVAL_SETTING_KEY,
} from './didit.constants';
import {
  SupplierComplianceStatus,
  WalletScreeningVerdict,
} from './didit.types';

/** Fila de `suppliers` tal como la devuelve la RPC de reclamo. */
interface ClaimedSupplier {
  id: string;
  user_id: string;
  name: string | null;
  bank_details: Record<string, unknown> | null;
  bridge_liquidation_address_id: string | null;
}

/**
 * Estados de una orden que todavía puede llegar a pagarse. Mismo conjunto que
 * usa `assertNoConflictingWalletToWorld` en payment-orders.service.ts — si ahí
 * se considera "activa", aquí también.
 */
const IN_FLIGHT_ORDER_STATUSES = [
  'created',
  'pending_review',
  'waiting_deposit',
  'processing',
];

/**
 * Re-screening periódico de las direcciones cripto ya registradas.
 *
 * La revisión al crear el beneficiario deja un veredicto congelado: una wallet
 * limpia puede quedar sancionada semanas después y Guira seguiría pagándole.
 * Este barrido cierra esa ventana.
 *
 * Servicio separado de `DiditWalletScreeningService` a propósito: aquel está
 * diseñado para no lanzar nunca y no escribir nada. Este sí escribe, notifica
 * y bloquea. Se apoya en aquel para la llamada al proveedor, donde ya están
 * resueltos el mapeo de redes y el manejo de errores.
 */
@Injectable()
export class DiditWalletRescreeningService {
  private readonly logger = new Logger(DiditWalletRescreeningService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly walletScreening: DiditWalletScreeningService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Configuración ──────────────────────────────────────────────────

  /**
   * Lee las tres claves de una sola consulta.
   *
   * El cron corre en un horario FIJO y el intervalo se lee aquí en cada
   * ejecución — mismo criterio que `ORDER_REVIEW_EXPIRY_HOURS` en
   * OrderReviewService. El intervalo es un dato de negocio, no la frecuencia
   * del tick, así que no hay que tocar el SchedulerRegistry para cambiarlo.
   */
  private async readConfig(): Promise<{
    enabled: boolean;
    intervalDays: number;
    batchSize: number;
  }> {
    const disabled = {
      enabled: false,
      intervalDays: WALLET_RESCREENING_DEFAULT_INTERVAL_DAYS,
      batchSize: WALLET_RESCREENING_DEFAULT_BATCH_SIZE,
    };

    const { data, error } = await this.supabase
      .from('app_settings')
      .select('key, value')
      .in('key', [
        WALLET_RESCREENING_ENABLED_SETTING_KEY,
        WALLET_RESCREENING_INTERVAL_SETTING_KEY,
        WALLET_RESCREENING_BATCH_SETTING_KEY,
      ]);

    if (error) {
      this.logger.warn(
        `No se pudo leer la configuración de re-screening (${error.message}) — ciclo omitido.`,
      );
      return disabled;
    }

    const map = Object.fromEntries(
      (data ?? []).map((row) => [row.key as string, row.value as string]),
    );

    const enabled =
      String(map[WALLET_RESCREENING_ENABLED_SETTING_KEY] ?? '')
        .trim()
        .toLowerCase() === 'true';

    // Un valor basura o absurdo cae al default en vez de romper el ciclo o,
    // peor, barrer la cartera entera con intervalo 0 por un typo.
    const parsedInterval = parseInt(
      map[WALLET_RESCREENING_INTERVAL_SETTING_KEY] ?? '',
      10,
    );
    const intervalDays =
      Number.isFinite(parsedInterval) && parsedInterval >= 0
        ? parsedInterval
        : WALLET_RESCREENING_DEFAULT_INTERVAL_DAYS;

    const parsedBatch = parseInt(
      map[WALLET_RESCREENING_BATCH_SETTING_KEY] ?? '',
      10,
    );
    const batchSize =
      Number.isFinite(parsedBatch) && parsedBatch > 0
        ? parsedBatch
        : WALLET_RESCREENING_DEFAULT_BATCH_SIZE;

    return { enabled, intervalDays, batchSize };
  }

  // ── Cron ───────────────────────────────────────────────────────────

  @Sentry.SentryCron('wallet-rescreening', {
    schedule: { type: 'interval', value: 1, unit: 'hour' },
    checkinMargin: 5,
    maxRuntime: 15,
  })
  @Cron(CronExpression.EVERY_HOUR, { name: 'wallet-rescreening' })
  async rescreenDueWallets(): Promise<void> {
    const { enabled, intervalDays, batchSize } = await this.readConfig();
    if (!enabled) return;

    // El reclamo es atómico (FOR UPDATE SKIP LOCKED dentro de la RPC): si
    // Render corre varias instancias, ninguna toma el mismo beneficiario y no
    // se paga dos veces la misma revisión.
    const { data: claimed, error } = await this.supabase.rpc(
      'claim_suppliers_for_rescreening',
      { p_interval_days: intervalDays, p_batch_size: batchSize },
    );

    if (error) {
      this.logger.error(
        `No se pudieron reclamar beneficiarios para re-screening: ${error.message}`,
      );
      Sentry.captureException(error, {
        extra: { operation: 'walletRescreening.claim' },
      });
      return;
    }

    const suppliers = (claimed ?? []) as ClaimedSupplier[];
    if (suppliers.length === 0) return;

    this.logger.log(
      `🔁 Re-screening: ${suppliers.length} beneficiario(s) reclamado(s) (intervalo ${intervalDays}d)`,
    );

    let blocked = 0;
    let flagged = 0;

    for (const supplier of suppliers) {
      try {
        const { complianceStatus } = await this.rescreenSupplier(supplier);
        if (complianceStatus === 'blocked') blocked += 1;
        if (complianceStatus === 'pending_review') flagged += 1;
      } catch (err) {
        // Un beneficiario que falle no debe abortar el resto del lote.
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Re-screening falló para el beneficiario ${supplier.id}: ${message}`,
        );
        Sentry.captureException(err, {
          extra: {
            operation: 'walletRescreening.rescreenSupplier',
            supplierId: supplier.id,
          },
        });
      }
    }

    this.logger.log(
      `🔁 Re-screening terminado: ${suppliers.length} revisado(s), ${blocked} bloqueado(s), ${flagged} en revisión`,
    );
  }

  // ── Revisión de un beneficiario ────────────────────────────────────

  /**
   * Fuerza el re-screening de un beneficiario concreto, sin esperar al cron
   * ni comprobar el intervalo. Lo usa el endpoint del staff.
   */
  async rescreenById(supplierId: string): Promise<{
    verdict: WalletScreeningVerdict;
    complianceStatus: SupplierComplianceStatus | null;
  }> {
    const { data, error } = await this.supabase
      .from('suppliers')
      .select('id, user_id, name, bank_details, bridge_liquidation_address_id')
      .eq('id', supplierId)
      .eq('payment_rail', 'crypto')
      .single();

    if (error || !data) {
      throw new NotFoundException('Beneficiario cripto no encontrado');
    }

    return this.rescreenSupplier(data as ClaimedSupplier);
  }

  private readVerdict(
    bankDetails: Record<string, unknown> | null,
  ): WalletScreeningVerdict | undefined {
    const raw = bankDetails?.wallet_screening;
    return raw && typeof raw === 'object'
      ? (raw as WalletScreeningVerdict)
      : undefined;
  }

  /** Screenea y aplica el resultado. Devuelve el veredicto fresco y el estado. */
  private async rescreenSupplier(supplier: ClaimedSupplier): Promise<{
    verdict: WalletScreeningVerdict;
    complianceStatus: SupplierComplianceStatus | null;
  }> {
    const bankDetails = supplier.bank_details ?? {};
    const walletAddress = bankDetails.wallet_address as string | undefined;
    const walletNetwork =
      (bankDetails.wallet_network as string | undefined) ?? 'solana';

    if (!walletAddress) {
      // Un beneficiario cripto sin dirección es un dato corrupto, no un caso
      // de riesgo: se registra y se deja pasar sin tocar su estado.
      this.logger.warn(
        `Beneficiario ${supplier.id} sin wallet_address — se omite.`,
      );
      return {
        verdict: {
          schema_version: 1,
          status: 'Skipped',
          decision: 'allow',
          screened_at: new Date().toISOString(),
          skip_reason: 'El beneficiario no tiene dirección registrada',
        },
        complianceStatus: null,
      };
    }

    const verdict = await this.walletScreening.screenBeneficiaryWallet({
      walletAddress,
      walletNetwork,
      userId: supplier.user_id,
    });

    const complianceStatus = this.decideComplianceStatus(verdict);

    await this.persistVerdict(supplier, verdict, complianceStatus);

    if (complianceStatus === 'blocked') {
      await this.onBlocked(supplier, verdict, walletNetwork);
    } else if (complianceStatus === 'pending_review') {
      await this.onFlaggedForReview(supplier, verdict);
    }

    return { verdict, complianceStatus };
  }

  /**
   * Traduce el veredicto a estado de cumplimiento.
   *
   * No se reutiliza `verdict.decision` a propósito: ese campo agrupa sanciones
   * y riesgo crítico en un mismo `block`, y aquí hay que separarlos. Las
   * sanciones bloquean solas porque es una obligación legal que no admite
   * espera; el riesgo crítico sin sanciones puede ser exposición indirecta
   * que cruzó un umbral, y bloquear por eso a un beneficiario que el cliente
   * lleva meses usando rompería operaciones legítimas sin que nadie lo mire.
   */
  private decideComplianceStatus(
    verdict: WalletScreeningVerdict,
  ): SupplierComplianceStatus | null {
    // Sin resultado real del proveedor no hay nada que aplicar.
    if (verdict.status === 'Skipped' || verdict.status === 'Error') return null;

    if (verdict.sanctions_hit === true) return 'blocked';
    if (verdict.severity === 'CRITICAL') return 'pending_review';

    return null;
  }

  /**
   * Guarda el veredicto nuevo conservando el anterior.
   *
   * Solo se conserva el último (no un historial): el rastro largo vive en
   * `audit_logs`, y el jsonb no es el sitio para acumular versiones. Sirve
   * para que compliance vea qué cambió respecto a la revisión previa.
   */
  private async persistVerdict(
    supplier: ClaimedSupplier,
    verdict: WalletScreeningVerdict,
    complianceStatus: SupplierComplianceStatus | null,
  ): Promise<void> {
    const bankDetails = { ...(supplier.bank_details ?? {}) };
    const previous = this.readVerdict(supplier.bank_details);

    if (previous) {
      // Se quita el sello del reclamo: es un detalle interno del cron y en el
      // veredicto archivado solo genera ruido.
      const { rescreen_claimed_at: _claim, ...cleanPrevious } = previous;
      bankDetails.wallet_screening_previous = cleanPrevious;
    }
    bankDetails.wallet_screening = verdict;

    const update: Record<string, unknown> = {
      bank_details: bankDetails,
      updated_at: new Date().toISOString(),
    };

    // `compliance_status` solo se escribe cuando hay hallazgo. Un beneficiario
    // limpio conserva el null que ya tenía — y uno que estaba bloqueado no
    // llega aquí, porque la RPC los excluye del reclamo.
    if (complianceStatus) {
      update.compliance_status = complianceStatus;
      update.compliance_reason = this.buildReason(verdict, complianceStatus);
      update.compliance_updated_at = new Date().toISOString();
    }

    const { error } = await this.supabase
      .from('suppliers')
      .update(update)
      .eq('id', supplier.id);

    if (error) {
      throw new Error(
        `No se pudo guardar el veredicto del beneficiario ${supplier.id}: ${error.message}`,
      );
    }
  }

  private buildReason(
    verdict: WalletScreeningVerdict,
    status: SupplierComplianceStatus,
  ): string {
    const parts: string[] = [];
    parts.push(
      status === 'blocked'
        ? 'Sanciones detectadas en la dirección'
        : 'Riesgo crítico sin sanciones confirmadas',
    );
    if (verdict.risk_score != null) parts.push(`score ${verdict.risk_score}`);
    if (verdict.severity) parts.push(`severidad ${verdict.severity}`);
    if (verdict.dominant_risk_category) {
      parts.push(`categoría ${verdict.dominant_risk_category}`);
    }
    if (verdict.provider) parts.push(`proveedor ${verdict.provider}`);
    return parts.join(' · ');
  }

  // ── Consecuencias de un bloqueo ────────────────────────────────────

  private async onBlocked(
    supplier: ClaimedSupplier,
    verdict: WalletScreeningVerdict,
    walletNetwork: string,
  ): Promise<void> {
    // Defensa en profundidad: además del guard de la capa de aplicación, se
    // mata el riel de pago real. Si algún punto de validación se escapara, la
    // liquidation address de Bridge ya no existe como destino activo.
    await this.deactivateLiquidationAddress(supplier);

    const inFlightOrders = await this.findInFlightOrders(supplier.id);

    await this.auditComplianceEvent(
      supplier,
      verdict,
      'SUPPLIER_COMPLIANCE_BLOCKED',
      inFlightOrders,
    );

    await this.notifyClientBlocked(supplier, walletNetwork);
    await this.notifyStaff(supplier, verdict, 'blocked', inFlightOrders);

    this.logger.warn(
      `🚫 Beneficiario ${supplier.id} BLOQUEADO por sanciones. ` +
        `Órdenes en curso afectadas: ${inFlightOrders.length}`,
    );
  }

  private async onFlaggedForReview(
    supplier: ClaimedSupplier,
    verdict: WalletScreeningVerdict,
  ): Promise<void> {
    const inFlightOrders = await this.findInFlightOrders(supplier.id);

    await this.auditComplianceEvent(
      supplier,
      verdict,
      'SUPPLIER_COMPLIANCE_FLAGGED',
      inFlightOrders,
    );

    // Al cliente NO se le avisa: es un hallazgo que nadie ha confirmado y
    // alarmarlo por algo que quizá se descarte no aporta nada. Además sigue
    // pudiendo operar con este beneficiario mientras compliance decide.
    await this.notifyStaff(supplier, verdict, 'pending_review', inFlightOrders);

    this.logger.warn(
      `⚠️  Beneficiario ${supplier.id} marcado para revisión de compliance ` +
        `(severidad ${verdict.severity ?? 'n/a'}, score ${verdict.risk_score ?? 'n/a'})`,
    );
  }

  private async deactivateLiquidationAddress(
    supplier: ClaimedSupplier,
  ): Promise<void> {
    if (!supplier.bridge_liquidation_address_id) return;

    // Bridge no expone DELETE para liquidation addresses; desactivarla
    // localmente es el máximo alcance posible, igual que hace
    // SuppliersService.deactivateOrphanedLiquidationAddress.
    const { error } = await this.supabase
      .from('bridge_liquidation_addresses')
      .update({ is_active: false })
      .eq('bridge_liquidation_address_id', supplier.bridge_liquidation_address_id)
      .eq('user_id', supplier.user_id);

    if (error) {
      this.logger.error(
        `No se pudo desactivar la liquidation address ${supplier.bridge_liquidation_address_id} ` +
          `del beneficiario bloqueado ${supplier.id}: ${error.message}. Requiere limpieza manual.`,
      );
    }
  }

  /**
   * Órdenes que todavía pueden llegar a pagarse hacia este beneficiario.
   *
   * No se cancelan automáticamente: pueden tener fondos ya comprometidos, y
   * esa decisión es del staff. Sus IDs van al audit trail y a la notificación
   * para que compliance pueda actuar sobre ellas.
   */
  private async findInFlightOrders(supplierId: string): Promise<string[]> {
    const { data, error } = await this.supabase
      .from('payment_orders')
      .select('id')
      .eq('supplier_id', supplierId)
      .in('status', IN_FLIGHT_ORDER_STATUSES);

    if (error) {
      this.logger.warn(
        `No se pudieron consultar las órdenes en curso del beneficiario ${supplierId}: ${error.message}`,
      );
      return [];
    }

    return (data ?? []).map((row) => row.id as string);
  }

  private async auditComplianceEvent(
    supplier: ClaimedSupplier,
    verdict: WalletScreeningVerdict,
    action: string,
    inFlightOrders: string[],
  ): Promise<void> {
    const { error } = await this.supabase.from('audit_logs').insert({
      performed_by: null,
      role: null,
      action,
      table_name: 'suppliers',
      record_id: supplier.id,
      new_values: {
        user_id: supplier.user_id,
        wallet_network: supplier.bank_details?.wallet_network ?? null,
        screening: verdict,
        in_flight_order_ids: inFlightOrders,
      },
      reason: 'Re-screening periódico de la dirección cripto',
      source: 'cron',
    });

    if (error) {
      this.logger.error(
        `No se pudo registrar ${action} en audit_logs para ${supplier.id}: ${error.message}`,
      );
    }
  }

  // ── Notificaciones ─────────────────────────────────────────────────

  /**
   * Aviso al cliente de que la cuenta dejó de ser admisible.
   *
   * El texto señala la DIRECCIÓN, no al cliente, y acota el daño de forma
   * explícita: al leer "cumplimiento" lo primero que la gente teme es que le
   * cierren la cuenta. Tampoco se menciona el proveedor, el score ni las
   * categorías de riesgo — eso es información interna de compliance y va al
   * panel del staff, no al cliente.
   */
  private async notifyClientBlocked(
    supplier: ClaimedSupplier,
    walletNetwork: string,
  ): Promise<void> {
    const name = supplier.name ?? 'tu beneficiario';
    const network =
      walletNetwork.charAt(0).toUpperCase() + walletNetwork.slice(1);

    await this.notifications.sendNotification({
      userId: supplier.user_id,
      type: NotificationType.COMPLIANCE,
      title: 'Beneficiario no disponible por cumplimiento',
      message:
        `La cuenta cripto de ${name} en la red ${network} dejó de estar disponible para envíos. ` +
        'Nuestra revisión de cumplimiento detectó que esa dirección está vinculada a actividad ' +
        'sancionada, y no podemos procesar pagos hacia ella. El resto de tus beneficiarios y tu ' +
        'cuenta no están afectados. Si crees que se trata de un error, escríbenos a soporte ' +
        'indicando el nombre del beneficiario.',
      link: '/panel/beneficiarios',
      referenceType: 'supplier',
      referenceId: supplier.id,
    });
  }

  private async notifyStaff(
    supplier: ClaimedSupplier,
    verdict: WalletScreeningVerdict,
    status: SupplierComplianceStatus,
    inFlightOrders: string[],
  ): Promise<void> {
    try {
      const { data: staffUsers } = await this.supabase
        .from('profiles')
        .select('id')
        .in('role', ['staff', 'admin', 'super_admin'])
        .eq('is_active', true);

      if (!staffUsers || staffUsers.length === 0) return;

      const detail = this.buildReason(verdict, status);
      const ordersNote =
        inFlightOrders.length > 0
          ? ` Hay ${inFlightOrders.length} orden(es) en curso hacia este beneficiario: ` +
            `${inFlightOrders.map((id) => id.slice(0, 8)).join(', ')}.`
          : ' No hay órdenes en curso hacia este beneficiario.';

      const title =
        status === 'blocked'
          ? 'Beneficiario cripto bloqueado por sanciones'
          : 'Beneficiario cripto requiere revisión de compliance';

      const message =
        status === 'blocked'
          ? `"${supplier.name ?? supplier.id}" quedó bloqueado automáticamente. ${detail}.${ordersNote}`
          : `"${supplier.name ?? supplier.id}" salió con riesgo crítico sin sanciones confirmadas y ` +
            `NO fue bloqueado: sigue operativo hasta que compliance decida. ${detail}.${ordersNote}`;

      // Inserción directa y no sendNotification() por fila: son N destinatarios
      // y un solo insert evita N round-trips.
      const rows = staffUsers.map((staff) => ({
        user_id: staff.id as string,
        type: NotificationType.COMPLIANCE,
        title,
        message,
        link: '/admin/beneficiarios-compliance',
        reference_type: 'supplier',
        reference_id: supplier.id,
        is_read: false,
      }));

      const { error } = await this.supabase.from('notifications').insert(rows);
      if (error) {
        this.logger.warn(
          `No se pudo notificar al staff sobre ${supplier.id}: ${error.message}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Error notificando al staff: ${message}`);
    }
  }
}
