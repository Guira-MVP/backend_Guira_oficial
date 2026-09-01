import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { throwDbError } from '../../core/utils/db-error.util';
import {
  CreateSupplierDto,
  UpdateSupplierDto,
} from './dto/create-supplier.dto';
import { BridgeService } from '../bridge/bridge.service';
import { FIAT_RAIL_TO_CURRENCY } from '../../common/constants/fiat-rail-catalog.constants';

/**
 * Rails que NO se integran con Bridge: el proveedor se guarda solo en la DB y el
 * pago se ejecuta manualmente con el proveedor financiero correspondiente.
 * 'pe_bank_transfer' → Perú, vía Pythas (integración pendiente de su documentación).
 */
const MANUAL_RAILS = ['pe_bank_transfer'];

/** Proveedor financiero que opera cada rail manual (se guarda en bank_details.provider). */
const MANUAL_RAIL_PROVIDERS: Record<string, string> = {
  pe_bank_transfer: 'pythas',
};

@Injectable()
export class SuppliersService {
  private readonly logger = new Logger(SuppliersService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly bridgeService: BridgeService,
  ) {}

  /**
   * Normaliza un email para comparación/almacenamiento (trim + lowercase).
   * Sin esto, "Juan@Test.com" y "juan@test.com" se tratan como contactos
   * distintos y evaden tanto el chequeo de duplicados como el índice único de DB.
   */
  private normalizeEmail(email: string | null | undefined): string | null {
    if (!email) return null;
    const normalized = email.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }

  private async assertCurrencyActiveForSupplier(currency: string): Promise<void> {
    const { data } = await this.supabase
      .from('currency_settings')
      .select('is_active_supplier')
      .eq('currency', currency.toLowerCase())
      .single();

    if (!data || !data.is_active_supplier) {
      throw new BadRequestException(
        `La divisa ${currency.toUpperCase()} no está habilitada para proveedores en este momento.`,
      );
    }
  }

  private async assertFiatSupplierCurrencyActive(
    currency: string,
  ): Promise<void> {
    const { data } = await this.supabase
      .from('va_source_currency_settings')
      .select('is_active_supplier')
      .eq('currency', currency.toLowerCase())
      .single();

    if (!data || !data.is_active_supplier) {
      throw new BadRequestException(
        `La divisa ${currency.toUpperCase()} no está habilitada para proveedores en este momento.`,
      );
    }
  }

  /** Devuelve los rails ya registrados por un email para un usuario. */
  async getExistingRailsForEmail(userId: string, email: string): Promise<{
    exists: boolean;
    supplierName?: string;
    usedRails: string[];
    usedNetworks: string[];
  }> {
    const normalizedEmail = this.normalizeEmail(email);
    if (!normalizedEmail) {
      return { exists: false, usedRails: [], usedNetworks: [] };
    }

    const { data } = await this.supabase
      .from('suppliers')
      .select('name, payment_rail, bank_details')
      .eq('user_id', userId)
      .eq('contact_email', normalizedEmail)
      .eq('is_active', true);

    if (!data || data.length === 0) {
      return { exists: false, usedRails: [], usedNetworks: [] };
    }

    const usedRails = data
      .filter((s) => s.payment_rail !== 'crypto')
      .map((s) => s.payment_rail as string);

    const usedNetworks = data
      .filter((s) => s.payment_rail === 'crypto')
      .map((s) => (s.bank_details as Record<string, string>)?.wallet_network)
      .filter(Boolean) as string[];

    return {
      exists: true,
      supplierName: data[0].name as string,
      usedRails,
      usedNetworks,
    };
  }

  /** Crea un proveedor para el usuario. */
  async create(userId: string, dto: CreateSupplierDto) {
    if (dto.payment_rail === 'ach_wire') {
      return this.createAchWireSupplierPair(userId, dto);
    }

    // Rails manuales: no pasan por Bridge (sin external account ni liquidation
    // address). Los datos bancarios se guardan tal cual en bank_details y la
    // operación se ejecuta fuera de la plataforma. Perú (proveedor Pythas) es el
    // primero; el esquema se ajustará cuando llegue su documentación.
    const isManualRail = MANUAL_RAILS.includes(dto.payment_rail);
    const isFiat = dto.payment_rail !== 'crypto' && !isManualRail;
    const normalizedEmail = this.normalizeEmail(dto.contact_email);

    // ── Verificar unicidad antes de llamar a Bridge ──────────────────
    // Para fiat: un proveedor activo por (user_id, email, payment_rail)
    // Para crypto: un proveedor activo por (user_id, email, wallet_network)
    // El email se normaliza (trim + lowercase) para que dos variantes de
    // mayúsculas/espacios del mismo correo no evadan esta verificación.
    if (normalizedEmail) {
      // Los rails manuales se verifican igual que los fiat: uno por (user_id,
      // email, payment_rail), tal como impone el índice único de la DB.
      if (isFiat || isManualRail) {
        const { data: existing } = await this.supabase
          .from('suppliers')
          .select('id, name')
          .eq('user_id', userId)
          .eq('contact_email', normalizedEmail)
          .eq('payment_rail', dto.payment_rail)
          .eq('is_active', true)
          .maybeSingle();

        if (existing) {
          throw new ConflictException(
            `El contacto "${normalizedEmail}" ya tiene una cuenta ${dto.payment_rail.toUpperCase()} registrada ` +
              `(proveedor: "${(existing as any).name}"). Usa "Añadir método" en la agenda para agregar otro rail.`,
          );
        }
      } else {
        const walletNetwork = dto.wallet_network?.toLowerCase() ?? 'solana';
        const { data: existing } = await this.supabase
          .from('suppliers')
          .select('id, name')
          .eq('user_id', userId)
          .eq('contact_email', normalizedEmail)
          .eq('payment_rail', 'crypto')
          .eq('is_active', true)
          .filter('bank_details->>wallet_network', 'eq', walletNetwork)
          .maybeSingle();

        if (existing) {
          throw new ConflictException(
            `El contacto "${normalizedEmail}" ya tiene una dirección en la red ${walletNetwork} ` +
              `(proveedor: "${(existing as any).name}"). Usa "Añadir método" para registrar otra red.`,
          );
        }
      }
    }

    let bridge_external_account_id: string | null = null;
    let bridge_liquidation_address_id: string | null = null;
    let beneficiary_address_valid: boolean | null = null;

    if (isFiat) {
      const fiatCurrency =
        FIAT_RAIL_TO_CURRENCY[dto.payment_rail] ?? dto.currency.toLowerCase();
      await this.assertFiatSupplierCurrencyActive(fiatCurrency);

      // Registrar cuenta externa en Bridge (valida KYC internamente)
      const ea = await this.bridgeService.createExternalAccount(userId, {
        account_owner_name: dto.name,
        currency: dto.currency.toLowerCase(),
        payment_rail: dto.payment_rail,
        bank_name: dto.bank_name,
        // ACH/Wire
        account_number: dto.account_number,
        routing_number: dto.routing_number,
        checking_or_savings: dto.checking_or_savings,
        address: dto.address,
        // SEPA
        iban: dto.iban,
        swift_bic: dto.swift_bic,
        iban_country: dto.iban_country,
        account_owner_type: dto.account_owner_type as 'individual' | 'business',
        first_name: dto.first_name,
        last_name: dto.last_name,
        business_name: dto.business_name,
        // SPEI
        clabe: dto.clabe,
        // PIX
        pix_key: dto.pix_key,
        br_code: dto.br_code,
        document_number: dto.document_number,
        // Bre-B
        bre_b_key: dto.bre_b_key,
        // FPS
        sort_code: dto.sort_code,
        // CO Bank Transfer
        bank_code: dto.bank_code,
        document_type: dto.document_type,
        phone_number: dto.phone_number,
      });

      bridge_external_account_id = ea.id;
      beneficiary_address_valid = (ea as any).beneficiary_address_valid ?? null;

      // Crear liquidation address apuntando a la external account recién creada
      try {
        const destinationCurrency =
          FIAT_RAIL_TO_CURRENCY[dto.payment_rail] ?? dto.currency.toLowerCase();

        const token = Date.now().toString(36).toUpperCase();
        const railRefs: Record<string, unknown> = {};
        if (dto.payment_rail === 'sepa') {
          railRefs.destination_sepa_reference = `Pago via Guira ${token}`;
        } else if (dto.payment_rail === 'wire') {
          railRefs.destination_wire_message = `Pago via Guira ${token}`;
        } else if (dto.payment_rail === 'ach') {
          railRefs.destination_ach_reference = 'GUIRA';
        } else if (dto.payment_rail === 'spei') {
          railRefs.destination_spei_reference = `Pago Guira ${token}`;
        } else if (dto.payment_rail === 'faster_payments') {
          railRefs.destination_reference = token;
        } else if (
          ['pix', 'bre_b', 'co_bank_transfer'].includes(dto.payment_rail)
        ) {
          railRefs.destination_reference = `Pago via Guira ${token}`;
        }

        const la = await this.bridgeService.createLiquidationAddress(userId, {
          currency: 'usdc',
          chain: 'solana',
          external_account_id: ea.bridge_external_account_id as string,
          destination_payment_rail: dto.payment_rail,
          destination_currency: destinationCurrency,
          ...railRefs,
        });

        bridge_liquidation_address_id =
          la.bridge_liquidation_address_id as string;
      } catch (err) {
        this.logger.error(
          `Proveedor ${dto.name}: external account creada (${ea.id}) pero falló la liquidation address: ${err.message}`,
        );
        // Rollback: eliminar la EA de Bridge y DB para que el cliente pueda reintentar
        // sin recibir "duplicate_external_account" de Bridge en el próximo intento.
        try {
          await this.bridgeService.deleteExternalAccount(userId, ea.id as string);
          this.logger.log(`Rollback exitoso: EA ${ea.id} eliminada de Bridge y DB`);
        } catch (rollbackErr) {
          this.logger.error(
            `Rollback fallido para EA ${ea.id}: ${rollbackErr.message}. Requiere limpieza manual en Bridge.`,
          );
        }
        throw new BadRequestException(
          'No se pudo registrar el proveedor porque los datos enviados son inválidos. ' +
            'Por favor revise la información ingresada (dirección, datos bancarios) e intente de nuevo.',
        );
      }
    } else if (!isManualRail) {
      // Proveedor crypto: crear liquidation address apuntando a la wallet del proveedor
      // Regla de moneda: Tron → USDT, todas las demás redes → USDC.
      // Esto evita el exchange rate de Bridge al mantener la misma moneda de entrada y salida.
      const isTron = (dto.wallet_network ?? 'solana').toLowerCase() === 'tron';
      const laCurrency = isTron ? 'usdt' : 'usdc';

      await this.assertCurrencyActiveForSupplier(laCurrency);

      try {

        const la = await this.bridgeService.createLiquidationAddress(userId, {
          currency: laCurrency,
          chain: 'solana',
          destination_address: dto.wallet_address,
          destination_payment_rail: dto.wallet_network ?? 'solana',
          destination_currency: laCurrency,
        });

        bridge_liquidation_address_id =
          la.bridge_liquidation_address_id as string;
      } catch (err) {
        this.logger.error(
          `Proveedor crypto ${dto.name}: falló la creación de liquidation address: ${err.message}`,
        );
        throw new BadRequestException(
          `No se pudo crear la liquidation address para el proveedor crypto: ${err.message}. ` +
            'Verifique los datos del wallet e intente nuevamente.',
        );
      }
    }

    const bank_details: Record<string, unknown> = isManualRail
      ? this.buildManualRailBankDetails(dto)
      : isFiat
      ? {
          bank_name: dto.bank_name,
          account_number: dto.account_number,
          routing_number: dto.routing_number,
          checking_or_savings: dto.checking_or_savings,
          iban: dto.iban,
          swift_bic: dto.swift_bic,
          iban_country: dto.iban_country,
          clabe: dto.clabe,
          pix_key: dto.pix_key,
          br_code: dto.br_code,
          document_number: dto.document_number,
          bre_b_key: dto.bre_b_key,
          sort_code: dto.sort_code,
          bank_code: dto.bank_code,
          document_type: dto.document_type,
          phone_number: dto.phone_number,
          account_owner_type: dto.account_owner_type,
          first_name: dto.first_name,
          last_name: dto.last_name,
          business_name: dto.business_name,
          address: dto.address ?? null,
        }
      : {
          wallet_address: dto.wallet_address,
          wallet_network: dto.wallet_network?.toLowerCase(),
          wallet_currency: dto.wallet_currency?.toLowerCase(),
        };

    // Para crypto, la moneda del proveedor es el token (usdc, usdt, etc.),
    // no una moneda fiat como USD.
    const supplierCurrency =
      isFiat || isManualRail
        ? dto.currency.toLowerCase()
        : (dto.wallet_currency?.toLowerCase() ?? dto.currency.toLowerCase());

    // Limpiar nulos/undefined visualmente
    Object.keys(bank_details).forEach(
      (k) =>
        bank_details[k as keyof typeof bank_details] === undefined &&
        delete bank_details[k as keyof typeof bank_details],
    );

    const { data, error } = await this.supabase
      .from('suppliers')
      .insert({
        user_id: userId,
        name: dto.name,
        currency: supplierCurrency,
        payment_rail: dto.payment_rail,
        bank_details,
        contact_email: normalizedEmail,
        notes: dto.notes ?? null,
        bridge_external_account_id,
        bridge_liquidation_address_id,
        is_active: true,
        is_verified: false,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException(
          'Proveedor duplicado: ya existe un proveedor activo con este email y método de pago.',
        );
      }

      // ── Rollback: ya se crearon recursos reales en Bridge (EA y/o LA) ──
      // pero el registro local no se pudo guardar. Sin esto quedarían huérfanos:
      // invisibles para el cliente y bloqueando un futuro reintento con los
      // mismos datos (Bridge rechazaría por "duplicate_external_account").
      this.logger.error(
        `Fallo al guardar proveedor "${dto.name}" en DB tras crear recursos en Bridge ` +
          `(EA local id=${bridge_external_account_id ?? 'n/a'}, LA bridge id=${bridge_liquidation_address_id ?? 'n/a'}): ${error.message}`,
      );

      if (bridge_external_account_id) {
        try {
          await this.bridgeService.deleteExternalAccount(
            userId,
            bridge_external_account_id,
          );
          this.logger.log(
            `Rollback: EA ${bridge_external_account_id} eliminada de Bridge tras fallo de insert del proveedor.`,
          );
        } catch (rollbackErr) {
          this.logger.error(
            `Rollback de EA ${bridge_external_account_id} falló: ${rollbackErr.message}. Requiere limpieza manual en Bridge.`,
          );
        }
      }

      if (bridge_liquidation_address_id) {
        // Bridge no expone DELETE para liquidation addresses — el máximo rollback
        // posible es desactivarla localmente y dejar rastro claro para limpieza manual.
        const { error: laDeactivateError } = await this.supabase
          .from('bridge_liquidation_addresses')
          .update({ is_active: false })
          .eq('bridge_liquidation_address_id', bridge_liquidation_address_id)
          .eq('user_id', userId);

        if (laDeactivateError) {
          this.logger.error(
            `No se pudo desactivar la Liquidation Address huérfana ${bridge_liquidation_address_id}: ${laDeactivateError.message}. Requiere limpieza manual.`,
          );
        } else {
          this.logger.warn(
            `Liquidation Address ${bridge_liquidation_address_id} desactivada localmente (huérfana en Bridge, sin dueño local) tras fallo de insert del proveedor.`,
          );
        }
      }

      throwDbError(error);
    }

    await this.supabase.from('audit_logs').insert({
      performed_by: userId,
      role: 'client',
      action: 'CREATE_SUPPLIER',
      table_name: 'suppliers',
      record_id: data.id,
      new_values: {
        name: dto.name,
        contact_email: normalizedEmail,
        payment_rail: dto.payment_rail,
        currency: supplierCurrency,
      },
    });

    return { ...data, beneficiary_address_valid };
  }

  /**
   * Crea un proveedor de EE.UU. con ambos rails (ACH y Wire) a partir de una sola
   * external account de Bridge — Bridge no distingue ACH de Wire a nivel de external
   * account (ambos son account_type "us"), solo a nivel de liquidation address
   * (destination_payment_rail). Reutilizar la misma EA para las dos liquidation
   * addresses evita el error "duplicate_external_account" que Bridge devuelve si se
   * intenta crear una segunda EA idéntica para el mismo cliente.
   */
  private async createAchWireSupplierPair(userId: string, dto: CreateSupplierDto) {
    const normalizedEmail = this.normalizeEmail(dto.contact_email);

    if (normalizedEmail) {
      const { data: existing } = await this.supabase
        .from('suppliers')
        .select('id, name, payment_rail')
        .eq('user_id', userId)
        .eq('contact_email', normalizedEmail)
        .in('payment_rail', ['ach', 'wire'])
        .eq('is_active', true)
        .maybeSingle();

      if (existing) {
        throw new ConflictException(
          `El contacto "${normalizedEmail}" ya tiene una cuenta ${(existing as any).payment_rail.toUpperCase()} registrada ` +
            `(proveedor: "${(existing as any).name}"). Usa "Añadir método" en la agenda para agregar el rail faltante.`,
        );
      }
    }

    await this.assertFiatSupplierCurrencyActive('usd');

    // Registrar la cuenta bancaria en Bridge una sola vez. El payload de Bridge para
    // ACH y Wire es idéntico (mismo account_type "us"), así que pasar payment_rail:
    // 'ach' aquí es arbitrario — nunca se reenvía 'ach_wire' a bridgeService/Bridge.
    const ea = await this.bridgeService.createExternalAccount(userId, {
      account_owner_name: dto.name,
      currency: dto.currency.toLowerCase(),
      payment_rail: 'ach',
      bank_name: dto.bank_name,
      account_number: dto.account_number,
      routing_number: dto.routing_number,
      checking_or_savings: dto.checking_or_savings,
      address: dto.address,
    });

    const beneficiary_address_valid =
      (ea as any).beneficiary_address_valid ?? null;

    const createLiquidationAddressForRail = (rail: 'ach' | 'wire') => {
      const token = Date.now().toString(36).toUpperCase();
      const railRefs =
        rail === 'ach'
          ? { destination_ach_reference: 'GUIRA' }
          : { destination_wire_message: `Pago via Guira ${token}` };

      return this.bridgeService.createLiquidationAddress(userId, {
        currency: 'usdc',
        chain: 'solana',
        external_account_id: ea.bridge_external_account_id as string,
        destination_payment_rail: rail,
        destination_currency: 'usd',
        ...railRefs,
      });
    };

    let laAch: Awaited<ReturnType<typeof createLiquidationAddressForRail>>;
    try {
      laAch = await createLiquidationAddressForRail('ach');
    } catch (err) {
      this.logger.error(
        `Proveedor ${dto.name} (ACH+Wire): external account creada (${ea.id}) pero falló la liquidation address ACH: ${err.message}`,
      );
      await this.rollbackOrphanedExternalAccount(userId, ea.id as string);
      throw new BadRequestException(
        'No se pudo registrar el proveedor porque los datos enviados son inválidos. ' +
          'Por favor revise la información ingresada (dirección, datos bancarios) e intente de nuevo.',
      );
    }

    let laWire: Awaited<ReturnType<typeof createLiquidationAddressForRail>>;
    try {
      laWire = await createLiquidationAddressForRail('wire');
    } catch (err) {
      this.logger.error(
        `Proveedor ${dto.name} (ACH+Wire): LA ACH (${laAch.bridge_liquidation_address_id}) creada pero falló la liquidation address Wire: ${err.message}`,
      );
      await this.deactivateOrphanedLiquidationAddress(
        userId,
        laAch.bridge_liquidation_address_id as string,
      );
      await this.rollbackOrphanedExternalAccount(userId, ea.id as string);
      throw new BadRequestException(
        'No se pudo registrar el proveedor porque los datos enviados son inválidos. ' +
          'Por favor revise la información ingresada (dirección, datos bancarios) e intente de nuevo.',
      );
    }

    const bank_details: Record<string, unknown> = {
      bank_name: dto.bank_name,
      account_number: dto.account_number,
      routing_number: dto.routing_number,
      checking_or_savings: dto.checking_or_savings,
      address: dto.address ?? null,
    };
    Object.keys(bank_details).forEach(
      (k) => bank_details[k] === undefined && delete bank_details[k],
    );

    const supplierCurrency = dto.currency.toLowerCase();
    const rows = [
      {
        user_id: userId,
        name: dto.name,
        currency: supplierCurrency,
        payment_rail: 'ach',
        bank_details,
        contact_email: normalizedEmail,
        notes: dto.notes ?? null,
        bridge_external_account_id: ea.id,
        bridge_liquidation_address_id: laAch.bridge_liquidation_address_id,
        is_active: true,
        is_verified: false,
      },
      {
        user_id: userId,
        name: dto.name,
        currency: supplierCurrency,
        payment_rail: 'wire',
        bank_details,
        contact_email: normalizedEmail,
        notes: dto.notes ?? null,
        bridge_external_account_id: ea.id,
        bridge_liquidation_address_id: laWire.bridge_liquidation_address_id,
        is_active: true,
        is_verified: false,
      },
    ];

    const { data, error } = await this.supabase
      .from('suppliers')
      .insert(rows)
      .select();

    if (error) {
      this.logger.error(
        `Fallo al guardar el par ACH+Wire "${dto.name}" en DB tras crear recursos en Bridge ` +
          `(EA local id=${ea.id}, LA ACH=${laAch.bridge_liquidation_address_id}, LA Wire=${laWire.bridge_liquidation_address_id}): ${error.message}`,
      );
      await this.deactivateOrphanedLiquidationAddress(
        userId,
        laAch.bridge_liquidation_address_id as string,
      );
      await this.deactivateOrphanedLiquidationAddress(
        userId,
        laWire.bridge_liquidation_address_id as string,
      );
      await this.rollbackOrphanedExternalAccount(userId, ea.id as string);
      throwDbError(error);
    }

    const achRow = data!.find((r) => r.payment_rail === 'ach')!;
    const wireRow = data!.find((r) => r.payment_rail === 'wire')!;

    await this.supabase.from('audit_logs').insert([
      {
        performed_by: userId,
        role: 'client',
        action: 'CREATE_SUPPLIER',
        table_name: 'suppliers',
        record_id: achRow.id,
        new_values: {
          name: dto.name,
          contact_email: normalizedEmail,
          payment_rail: 'ach',
          currency: supplierCurrency,
        },
      },
      {
        performed_by: userId,
        role: 'client',
        action: 'CREATE_SUPPLIER',
        table_name: 'suppliers',
        record_id: wireRow.id,
        new_values: {
          name: dto.name,
          contact_email: normalizedEmail,
          payment_rail: 'wire',
          currency: supplierCurrency,
        },
      },
    ]);

    return {
      ach: { ...achRow, beneficiary_address_valid },
      wire: { ...wireRow, beneficiary_address_valid },
    };
  }

  /**
   * bank_details de un proveedor con rail manual (sin Bridge).
   *
   * Todos los campos son opcionales por diseño: el rail de Perú se registró antes
   * de tener la documentación de Pythas, así que se guarda lo que el usuario
   * tenga a mano y luego se ajustará.
   *
   * La dirección se guarda PLANA, sin la clave `address`, por dos motivos:
   * (1) el constraint `suppliers_address_minimum_fields` exige street_line_1,
   * city y country dentro de `address`, incompatible con campos opcionales, y
   * (2) `address` es el formato de Bridge (state máx 3 caracteres), que no admite
   * nombres de provincia peruanos como "Lima" o "Arequipa".
   */
  private buildManualRailBankDetails(
    dto: CreateSupplierDto,
  ): Record<string, unknown> {
    return {
      bank_name: dto.bank_name,
      account_number: dto.account_number,
      checking_or_savings: dto.checking_or_savings,
      cci: dto.cci,
      swift_bic: dto.swift_bic,
      address_line: dto.address_line,
      district: dto.district,
      province: dto.province,
      department: dto.department,
      postal_code: dto.postal_code,
      country: dto.address_country,
      provider: MANUAL_RAIL_PROVIDERS[dto.payment_rail],
    };
  }

  /** Elimina una external account huérfana de Bridge tras un fallo parcial. */
  private async rollbackOrphanedExternalAccount(
    userId: string,
    eaId: string,
  ): Promise<void> {
    try {
      await this.bridgeService.deleteExternalAccount(userId, eaId);
      this.logger.log(`Rollback exitoso: EA ${eaId} eliminada de Bridge y DB`);
    } catch (rollbackErr) {
      this.logger.error(
        `Rollback fallido para EA ${eaId}: ${rollbackErr.message}. Requiere limpieza manual en Bridge.`,
      );
    }
  }

  /**
   * Desactiva localmente una liquidation address huérfana. Bridge no expone DELETE
   * para liquidation addresses, así que el máximo rollback posible es marcarla
   * inactiva localmente y dejar rastro para limpieza manual.
   */
  private async deactivateOrphanedLiquidationAddress(
    userId: string,
    bridgeLiquidationAddressId: string,
  ): Promise<void> {
    const { error } = await this.supabase
      .from('bridge_liquidation_addresses')
      .update({ is_active: false })
      .eq('bridge_liquidation_address_id', bridgeLiquidationAddressId)
      .eq('user_id', userId);

    if (error) {
      this.logger.error(
        `No se pudo desactivar la Liquidation Address huérfana ${bridgeLiquidationAddressId}: ${error.message}. Requiere limpieza manual.`,
      );
    } else {
      this.logger.warn(
        `Liquidation Address ${bridgeLiquidationAddressId} desactivada localmente (huérfana en Bridge) tras fallo parcial de creación.`,
      );
    }
  }

  /** Lista proveedores activos del usuario. */
  async findAll(userId: string) {
    const { data, error } = await this.supabase
      .from('suppliers')
      .select('*, bridge_external_accounts ( bank_name, country )')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('name');

    if (error) throwDbError(error);
    const suppliers = (data ?? []).map((supplier) =>
      this.mapBridgeDetailsToBankDetails(supplier),
    );
    return this.attachLiquidationFee(userId, suppliers);
  }

  /** Detalle de un proveedor. */
  async findOne(supplierId: string, userId: string) {
    const { data, error } = await this.supabase
      .from('suppliers')
      .select('*, bridge_external_accounts ( bank_name, country )')
      .eq('id', supplierId)
      .eq('user_id', userId)
      .single();

    if (error || !data) throw new NotFoundException('Proveedor no encontrado');
    const supplier = this.mapBridgeDetailsToBankDetails(data);
    const [withFee] = await this.attachLiquidationFee(userId, [supplier]);
    return withFee;
  }

  /**
   * Adjunta `developer_fee_percent` (fee real de la liquidation address de Bridge)
   * a cada proveedor. Es la fuente de verdad del fee para el flujo bolivia_to_wallet:
   * el panel del cliente debe mostrar este valor y el backend lo usa al guardar el
   * payment_order. Como `suppliers.bridge_liquidation_address_id` empareja con
   * `bridge_liquidation_addresses.bridge_liquidation_address_id` (sin FK para embed
   * de PostgREST), se resuelve con una segunda consulta + map.
   */
  private async attachLiquidationFee<T extends { bridge_liquidation_address_id?: string | null }>(
    userId: string,
    suppliers: T[],
  ): Promise<Array<T & { developer_fee_percent: number | null }>> {
    const laIds = Array.from(
      new Set(
        suppliers
          .map((s) => s.bridge_liquidation_address_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    );

    if (laIds.length === 0) {
      return suppliers.map((s) => ({ ...s, developer_fee_percent: null }));
    }

    const { data: liquidationAddresses } = await this.supabase
      .from('bridge_liquidation_addresses')
      .select('bridge_liquidation_address_id, developer_fee_percent')
      .eq('user_id', userId)
      .in('bridge_liquidation_address_id', laIds);

    const feeByLaId = new Map<string, number | null>(
      (liquidationAddresses ?? []).map((la) => {
        const raw = la.developer_fee_percent;
        const parsed = raw === null || raw === undefined ? null : Number(raw);
        return [
          la.bridge_liquidation_address_id as string,
          parsed !== null && Number.isFinite(parsed) ? parsed : null,
        ];
      }),
    );

    return suppliers.map((s) => ({
      ...s,
      developer_fee_percent: s.bridge_liquidation_address_id
        ? (feeByLaId.get(s.bridge_liquidation_address_id) ?? null)
        : null,
    }));
  }

  private mapBridgeDetailsToBankDetails(supplier: any) {
    if (supplier.bridge_external_accounts) {
      if (!supplier.bank_details) supplier.bank_details = {};
      const { bank_name } = supplier.bridge_external_accounts;
      if (bank_name && !supplier.bank_details.bank_name) {
        supplier.bank_details.bank_name = bank_name;
      }
    }
    delete supplier.bridge_external_accounts;
    return supplier;
  }

  /** Actualiza un proveedor. Sincroniza con Bridge cuando aplica. */
  async update(supplierId: string, userId: string, dto: UpdateSupplierDto) {
    // Verificar propiedad y obtener datos actuales
    const existing = await this.findOne(supplierId, userId);

    // ── Bloquear edición de campos bancarios inmutables si hay EA en Bridge ──
    // Bridge Update API solo permite: address + US account (routing_number, checking_or_savings)
    // Para cambiar iban, clabe, pix_key, account_number, etc. se debe crear un proveedor nuevo.
    const hasBridgeEA = !!existing.bridge_external_account_id;
    if (hasBridgeEA) {
      const immutableFields = [
        'iban',
        'swift_bic',
        'iban_country',
        'clabe',
        'pix_key',
        'br_code',
        'bre_b_key',
        'account_number',
        // CO Bank Transfer: inmutables en Bridge una vez registrados
        'bank_code',
        'document_type',
        'document_number',
        'phone_number',
      ] as const;

      const blockedFields = immutableFields.filter(
        (f) =>
          dto[f] !== undefined &&
          dto[f] !== (existing.bank_details?.[f] as string),
      );

      if (blockedFields.length > 0) {
        throw new BadRequestException(
          `No se pueden modificar los campos bancarios [${blockedFields.join(', ')}] ` +
            'porque este proveedor ya tiene una cuenta registrada en Bridge. ' +
            'Crea un proveedor nuevo con los datos actualizados.',
        );
      }
    }

    // ── Construir updateData para DB ──
    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.currency !== undefined)
      updateData.currency = dto.currency.toLowerCase();
    if (dto.payment_rail !== undefined)
      updateData.payment_rail = dto.payment_rail;
    if (dto.contact_email !== undefined)
      updateData.contact_email = this.normalizeEmail(dto.contact_email);
    if (dto.notes !== undefined) updateData.notes = dto.notes;

    // Si es crypto y se actualiza wallet_currency, actualizar currency también
    if (
      dto.wallet_currency !== undefined &&
      existing.payment_rail === 'crypto'
    ) {
      updateData.currency = dto.wallet_currency.toLowerCase();
    }

    // Actualizar bank_details si hay campos bancarios/crypto en el DTO
    const bankFieldsToMerge: Record<string, unknown> = {};
    if (dto.bank_name !== undefined)
      bankFieldsToMerge.bank_name = dto.bank_name;
    if (dto.routing_number !== undefined)
      bankFieldsToMerge.routing_number = dto.routing_number;
    if (dto.checking_or_savings !== undefined)
      bankFieldsToMerge.checking_or_savings = dto.checking_or_savings;
    if (dto.wallet_address !== undefined)
      bankFieldsToMerge.wallet_address = dto.wallet_address;
    if (dto.wallet_network !== undefined)
      bankFieldsToMerge.wallet_network = dto.wallet_network.toLowerCase();
    if (dto.wallet_currency !== undefined)
      bankFieldsToMerge.wallet_currency = dto.wallet_currency.toLowerCase();

    // Rails manuales (Perú/Pythas): al no existir external account en Bridge, no
    // hay campos inmutables — todos los datos bancarios se pueden corregir aquí.
    if (MANUAL_RAILS.includes(existing.payment_rail)) {
      if (dto.account_number !== undefined)
        bankFieldsToMerge.account_number = dto.account_number;
      if (dto.cci !== undefined) bankFieldsToMerge.cci = dto.cci;
      if (dto.swift_bic !== undefined)
        bankFieldsToMerge.swift_bic = dto.swift_bic;
      if (dto.address_line !== undefined)
        bankFieldsToMerge.address_line = dto.address_line;
      if (dto.district !== undefined) bankFieldsToMerge.district = dto.district;
      if (dto.province !== undefined) bankFieldsToMerge.province = dto.province;
      if (dto.department !== undefined)
        bankFieldsToMerge.department = dto.department;
      if (dto.postal_code !== undefined)
        bankFieldsToMerge.postal_code = dto.postal_code;
      if (dto.address_country !== undefined)
        bankFieldsToMerge.country = dto.address_country;
    }

    if (Object.keys(bankFieldsToMerge).length > 0) {
      updateData.bank_details = {
        ...((existing.bank_details as Record<string, unknown>) ?? {}),
        ...bankFieldsToMerge,
      };
    }

    // ── Sincronizar External Account con Bridge si aplica ──
    // Bridge PUT requiere address; si solo cambian campos US (routing_number,
    // checking_or_savings), cargamos la address existente de bank_details.
    const hasUsFieldChanges =
      (existing.payment_rail === 'ach' || existing.payment_rail === 'wire') &&
      (dto.routing_number !== undefined || dto.checking_or_savings !== undefined);

    if (hasBridgeEA && (dto.address || hasUsFieldChanges)) {
      try {
        // Resolver address: usar la del DTO si viene, sino cargar la existente
        const addressForBridge = dto.address ?? existing.bank_details?.address;

        if (addressForBridge && addressForBridge.street_line_1 && addressForBridge.city && addressForBridge.country) {
          await this.bridgeService.updateExternalAccount(
            userId,
            existing.bridge_external_account_id,
            {
              address: addressForBridge,
              // Solo para US: routing_number y checking_or_savings
              ...(existing.payment_rail === 'ach' ||
              existing.payment_rail === 'wire'
                ? {
                    account: {
                      ...(dto.routing_number
                        ? { routing_number: dto.routing_number }
                        : {}),
                      ...(dto.checking_or_savings
                        ? {
                            checking_or_savings: dto.checking_or_savings as
                              | 'checking'
                              | 'savings',
                          }
                        : {}),
                    },
                  }
                : {}),
            },
          );
        } else {
          this.logger.warn(
            `Bridge update para EA ${existing.bridge_external_account_id} omitido: no hay address válida disponible (ni en DTO ni en bank_details)`,
          );
        }
      } catch (err) {
        // Log pero no bloquear — la DB local se actualiza igualmente
        this.logger.warn(
          `Bridge update para EA ${existing.bridge_external_account_id} falló: ${err.message}`,
        );
      }
    }

    // ── Sincronizar Liquidation Address con Bridge si aplica ──
    // Bridge PUT /liquidation_addresses permite actualizar: external_account_id,
    // custom_developer_fee_percent, y referencias de pago.
    if (existing.bridge_liquidation_address_id) {
      const laUpdatePayload: Record<string, string | null | undefined> = {};

      // Si cambia wallet_address para proveedores crypto, no se puede actualizar
      // destination_address en la LA — requeriría crear una nueva LA.
      // Pero sí podemos actualizar referencias de pago si se añaden en el futuro.

      if (Object.keys(laUpdatePayload).length > 0) {
        try {
          await this.bridgeService.updateLiquidationAddress(
            userId,
            existing.bridge_liquidation_address_id,
            laUpdatePayload,
          );
        } catch (err) {
          this.logger.warn(
            `Bridge update para LA ${existing.bridge_liquidation_address_id} falló: ${err.message}`,
          );
        }
      }
    }

    const { data, error } = await this.supabase
      .from('suppliers')
      .update(updateData)
      .eq('id', supplierId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throwDbError(error);

    await this.supabase.from('audit_logs').insert({
      performed_by: userId,
      role: 'client',
      action: 'UPDATE_SUPPLIER',
      table_name: 'suppliers',
      record_id: supplierId,
      old_values: {
        name: existing.name,
        contact_email: existing.contact_email,
        notes: existing.notes,
      },
      new_values: {
        name: data.name,
        contact_email: data.contact_email,
        notes: data.notes,
      },
    });

    return data;
  }

  /** Desactiva (soft delete) un proveedor. */
  async remove(supplierId: string, userId: string) {
    const existing = await this.findOne(supplierId, userId);

    await this.supabase
      .from('suppliers')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', supplierId)
      .eq('user_id', userId);

    await this.supabase.from('audit_logs').insert({
      performed_by: userId,
      role: 'client',
      action: 'DEACTIVATE_SUPPLIER',
      table_name: 'suppliers',
      record_id: supplierId,
      old_values: {
        name: existing.name,
        contact_email: existing.contact_email,
        payment_rail: existing.payment_rail,
      },
    });

    return { message: 'Proveedor desactivado' };
  }

  /**
   * Devuelve los proveedores que coinciden con los IDs dados.
   * Uso interno del servicio de exportación (no paginado, solo id+name).
   */
  async findByIds(ids: string[], userId: string): Promise<{ id: string; name: string }[]> {
    if (ids.length === 0) return [];
    const { data } = await this.supabase
      .from('suppliers')
      .select('id, name')
      .eq('user_id', userId)
      .in('id', ids);
    return (data ?? []) as { id: string; name: string }[];
  }
}

