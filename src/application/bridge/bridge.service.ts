import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { throwDbError } from '../../core/utils/db-error.util';
import { BridgeApiClient } from './bridge-api.client';
import { PAYMENT_RAIL_TO_BRIDGE_ACCOUNT_TYPE } from './bridge.constants';
import { FeesService } from '../fees/fees.service';
import { LedgerService } from '../ledger/ledger.service';
import { CreatePayoutRequestDto } from './dto/create-payout.dto';
import {
  CreateVirtualAccountDto,
  CreateExternalAccountDto,
} from './dto/create-virtual-account.dto';
import { CreateLiquidationAddressDto } from './dto/create-liquidation-address.dto';
import { UpdateVirtualAccountDto } from './dto/update-virtual-account.dto';
import {
  VIRTUAL_ACCOUNT_FLOW,
  VIRTUAL_ACCOUNT_EXTERNAL_FLOW,
} from '../../common/constants/flow-access.constants';

@Injectable()
export class BridgeService {
  private readonly logger = new Logger(BridgeService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly bridgeApi: BridgeApiClient,
    private readonly feesService: FeesService,
    private readonly ledgerService: LedgerService,
  ) {}

  // ═══════════════════════════════════════════════════
  //  VIRTUAL ACCOUNTS (depósitos entrantes)
  // ═══════════════════════════════════════════════════

  private async assertCurrencyActive(currency: string): Promise<void> {
    const { data } = await this.supabase
      .from('currency_settings')
      .select('is_active_va')
      .eq('currency', currency.toLowerCase())
      .single();

    if (!data || !data.is_active_va) {
      throw new BadRequestException(
        `La divisa ${currency.toUpperCase()} no está habilitada para cuentas virtuales.`,
      );
    }
  }

  private async assertVaSourceCurrencyActive(currency: string): Promise<void> {
    const { data } = await this.supabase
      .from('va_source_currency_settings')
      .select('is_active')
      .eq('currency', currency.toLowerCase())
      .single();

    if (!data || !data.is_active) {
      throw new BadRequestException(
        `Los depósitos en ${currency.toUpperCase()} no están disponibles actualmente.`,
      );
    }
  }

  /**
   * Barrera de visibilidad: la sección de Cuentas Virtuales está habilitada por
   * defecto para todos los clientes (independiente del país), pero el staff puede
   * apagarla por cliente con un override (customer_flow_overrides, is_enabled=false).
   */
  private async assertVirtualAccountEnabled(userId: string): Promise<void> {
    const { data } = await this.supabase
      .from('customer_flow_overrides')
      .select('is_enabled')
      .eq('user_id', userId)
      .eq('flow_type', VIRTUAL_ACCOUNT_FLOW)
      .eq('is_active', true)
      .maybeSingle();

    if (data && data.is_enabled === false) {
      throw new ForbiddenException(
        'Las Cuentas Virtuales no están habilitadas para tu cuenta. Contacta a soporte si crees que es un error.',
      );
    }
  }

  /**
   * Barrera de acceso: las cuentas virtuales con destino externo están deshabilitadas
   * por defecto. El staff debe habilitarlas explícitamente por cliente mediante un
   * override (customer_flow_overrides, flow_type='virtual_account_external', is_enabled=true).
   */
  private async assertExternalVirtualAccountEnabled(userId: string): Promise<void> {
    const { data } = await this.supabase
      .from('customer_flow_overrides')
      .select('is_enabled')
      .eq('user_id', userId)
      .eq('flow_type', VIRTUAL_ACCOUNT_EXTERNAL_FLOW)
      .eq('is_active', true)
      .maybeSingle();

    if (!data || data.is_enabled === false) {
      throw new ForbiddenException(
        'Las cuentas virtuales con destino externo están disponibles bajo solicitud. Contacta a soporte para habilitarlas en tu cuenta.',
      );
    }
  }

  /** Retorna las capacidades del cliente para crear cuentas virtuales. */
  async getVirtualAccountCapabilities(
    userId: string,
  ): Promise<{ canCreateExternal: boolean }> {
    const { data } = await this.supabase
      .from('customer_flow_overrides')
      .select('is_enabled')
      .eq('user_id', userId)
      .eq('flow_type', VIRTUAL_ACCOUNT_EXTERNAL_FLOW)
      .eq('is_active', true)
      .maybeSingle();

    return { canCreateExternal: !!(data && data.is_enabled === true) };
  }

  /** Crea Virtual Account en Bridge + guarda en DB. */
  async createVirtualAccount(userId: string, dto: CreateVirtualAccountDto) {
    await this.assertVirtualAccountEnabled(userId);
    const profile = await this.getVerifiedProfile(userId);

    await this.assertCurrencyActive(dto.destination_currency);
    await this.assertVaSourceCurrencyActive(dto.source_currency);

    // Validación: no pueden venir ambos destinos a la vez
    if (dto.destination_wallet_id && dto.destination_address) {
      throw new BadRequestException(
        'No puedes especificar destination_wallet_id y destination_address al mismo tiempo. ' +
          'Usa destination_wallet_id para fondear tu wallet en Guira, o destination_address para enviar a una wallet externa (Binance, MetaMask, etc.).',
      );
    }

    // ── Validar límites de creación de VAs (configurables desde app_settings) ──
    const vaLimits = await this.getVaCreationLimits();

    const { count: totalActive } = await this.supabase
      .from('bridge_virtual_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'active');

    if ((totalActive ?? 0) >= vaLimits.maxTotal) {
      throw new BadRequestException(
        `Has alcanzado el límite máximo de ${vaLimits.maxTotal} cuentas virtuales activas. Desactiva alguna antes de crear una nueva.`,
      );
    }

    // ── Determinar destino ──────────────────────────────
    let destinationAddress: string | undefined;
    let isExternalSweep = false;
    const destinationType = dto.destination_address
      ? 'wallet_external'
      : 'wallet_bridge';

    if (dto.destination_address) {
      await this.assertExternalVirtualAccountEnabled(userId);

      destinationAddress = dto.destination_address;
      isExternalSweep = true;

      // Verificar unicidad: no dos VAs externas con misma dirección por moneda
      const { data: existingExternal } = await this.supabase
        .from('bridge_virtual_accounts')
        .select('id')
        .eq('user_id', userId)
        .eq('source_currency', dto.source_currency.toLowerCase())
        .eq('destination_address', dto.destination_address)
        .eq('is_external_sweep', true)
        .eq('status', 'active')
        .maybeSingle();

      if (existingExternal) {
        throw new BadRequestException(
          `Ya tienes una cuenta virtual activa en ${dto.source_currency.toUpperCase()} apuntando a esa dirección externa.`,
        );
      }

      // Verificar límite de VAs externas por moneda
      const { count: externalCount } = await this.supabase
        .from('bridge_virtual_accounts')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('source_currency', dto.source_currency.toLowerCase())
        .eq('is_external_sweep', true)
        .eq('status', 'active');

      if ((externalCount ?? 0) >= vaLimits.maxExternalPerCurrency) {
        throw new BadRequestException(
          `Has alcanzado el límite de ${vaLimits.maxExternalPerCurrency} cuentas virtuales externas activas para ${dto.source_currency.toUpperCase()}. Desactiva alguna antes de crear otra.`,
        );
      }

      this.logger.log(
        `VA con destino externo para user ${userId}: ${dto.destination_address} (${dto.destination_label ?? 'sin etiqueta'})`,
      );
    } else {
      // Para wallet_bridge: máximo 1 VA por moneda
      const { data: existingBridge } = await this.supabase
        .from('bridge_virtual_accounts')
        .select('id')
        .eq('user_id', userId)
        .eq('source_currency', dto.source_currency.toLowerCase())
        .eq('is_external_sweep', false)
        .eq('status', 'active')
        .maybeSingle();

      if (existingBridge) {
        throw new BadRequestException(
          `Ya tienes una cuenta virtual activa en ${dto.source_currency.toUpperCase()} apuntando a tu wallet de Bridge.`,
        );
      }

      if (dto.destination_wallet_id) {
        const { data: wallet } = await this.supabase
          .from('wallets')
          .select('address')
          .eq('id', dto.destination_wallet_id)
          .eq('user_id', userId)
          .single();
        destinationAddress = wallet?.address;
      }
    }

    // ── Resolver developer_fee_percent (2 niveles) ──────────────────
    // 1. Override por usuario (va_fee_overrides) → 2. Fee global (va_fee_defaults)
    const devFeePercent = await this.resolveVaFee(
      userId,
      dto.source_currency.toLowerCase(),
      destinationType,
    );

    // ── Crear en Bridge (formato anidado source/destination) ──
    const bridgePayload: Record<string, unknown> = {
      source: { currency: dto.source_currency.toLowerCase() },
      destination: {
        payment_rail: dto.destination_payment_rail,
        currency: dto.destination_currency.toLowerCase(),
        ...(destinationAddress ? { address: destinationAddress } : {}),
      },
    };

    // Solo enviar developer_fee_percent si tiene valor
    if (devFeePercent != null) {
      bridgePayload.developer_fee_percent = devFeePercent.toString();
    }

    const bridgeVA = await this.bridgeApi.post<Record<string, unknown>>(
      `/v0/customers/${profile.bridge_customer_id}/virtual_accounts`,
      bridgePayload,
      `va-${userId}-${dto.source_currency}-${Date.now()}`,
    );

    // ── Extraer TODOS los campos de source_deposit_instructions ──
    const sdi =
      (bridgeVA.source_deposit_instructions as Record<string, unknown>) ?? {};
    const bridgeDest = (bridgeVA.destination as Record<string, unknown>) ?? {};

    // Guardar en DB con todos los campos de la respuesta de Bridge
    const { data, error } = await this.supabase
      .from('bridge_virtual_accounts')
      .insert({
        user_id: userId,
        bridge_virtual_account_id: bridgeVA.id,
        bridge_customer_id: profile.bridge_customer_id,
        source_currency: dto.source_currency.toLowerCase(),
        destination_currency: dto.destination_currency.toLowerCase(),
        destination_payment_rail: dto.destination_payment_rail,
        destination_address:
          (bridgeDest.address as string) ?? destinationAddress ?? null,
        destination_wallet_id: dto.destination_wallet_id ?? null,
        is_external_sweep: isExternalSweep,
        external_destination_label: dto.destination_label ?? null,
        // ── Campos de source_deposit_instructions (respuesta de Bridge) ──
        bank_name: (sdi.bank_name as string) ?? null,
        bank_address: (sdi.bank_address as string) ?? null,
        beneficiary_name: (sdi.bank_beneficiary_name as string) ?? null,
        beneficiary_address: (sdi.bank_beneficiary_address as string) ?? null,
        routing_number: (sdi.bank_routing_number as string) ?? null,
        account_number: (sdi.bank_account_number as string) ?? null,
        // Campos multi-divisa (Bridge los devuelve según source_currency)
        iban: (sdi.iban as string) ?? null,
        clabe: (sdi.clabe as string) ?? null,
        br_code: (sdi.br_code as string) ?? null,
        sort_code: (sdi.sort_code as string) ?? null,
        payment_rails: (sdi.payment_rails as string[]) ?? null,
        // Titular de la cuenta
        account_holder_name: (sdi.account_holder_name as string) ?? null,
        // Mensaje de depósito: específico de COP/Bre-B
        deposit_message: (sdi.deposit_message as string) ?? null,
        // Fee confirmado por Bridge (fuente de verdad)
        // Si Bridge no lo devuelve, usamos el cálculo local como fallback
        developer_fee_percent:
          bridgeVA.developer_fee_percent !== undefined &&
          bridgeVA.developer_fee_percent !== null
            ? parseFloat(bridgeVA.developer_fee_percent as string)
            : devFeePercent,
        status: 'active',
      })
      .select()
      .single();

    if (error) throwDbError(error);
    return data;
  }

  /** Lista virtual accounts del usuario. */
  async listVirtualAccounts(userId: string) {
    const { data, error } = await this.supabase
      .from('bridge_virtual_accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('created_at');

    if (error) throwDbError(error);
    return data ?? [];
  }

  /** Detalle de una virtual account. */
  async getVirtualAccount(vaId: string, userId: string) {
    const { data, error } = await this.supabase
      .from('bridge_virtual_accounts')
      .select('*')
      .eq('id', vaId)
      .eq('user_id', userId)
      .single();

    if (error || !data)
      throw new NotFoundException('Cuenta virtual no encontrada');
    return data;
  }

  /** Desactiva VA en Bridge + DB. */
  async deactivateVirtualAccount(vaId: string, userId: string) {
    const va = await this.getVirtualAccount(vaId, userId);

    if (this.bridgeApi.isConfigured && va.bridge_virtual_account_id) {
      try {
        await this.bridgeApi.delete(
          `/v0/virtual_accounts/${va.bridge_virtual_account_id}`,
        );
      } catch (err) {
        this.logger.warn(`Error desactivando VA en Bridge: ${err}`);
      }
    }

    await this.supabase
      .from('bridge_virtual_accounts')
      .update({ status: 'inactive', deactivated_at: new Date().toISOString() })
      .eq('id', vaId);

    return { message: 'Cuenta virtual desactivada' };
  }

  // ═══════════════════════════════════════════════════
  //  EXTERNAL ACCOUNTS (cuentas bancarias destino)
  // ═══════════════════════════════════════════════════

  /**
   * Registra cuenta bancaria externa en Bridge + guarda en DB.
   *
   * - Deriva `account_type` de Bridge a partir del `payment_rail` del DTO.
   * - Usa `checking_or_savings` (no `account_type`) dentro del objeto `account` para US.
   * - Envía `address` del beneficiario cuando se proporciona (recomendado para US).
   * - Envía `account_owner_type`/`first_name`/`last_name`/`business_name` para IBAN.
   * - Guarda `beneficiary_address_valid` de la respuesta de Bridge.
   */
  async createExternalAccount(userId: string, dto: CreateExternalAccountDto) {
    const profile = await this.getVerifiedProfile(userId);

    // Validar longitud de account_owner_name para ACH/Wire (Bridge exige 3-35)
    if (
      (dto.payment_rail === 'ach' || dto.payment_rail === 'wire') &&
      (dto.account_owner_name.length < 3 || dto.account_owner_name.length > 35)
    ) {
      throw new BadRequestException(
        'Para transferencias ACH/Wire, account_owner_name debe tener entre 3 y 35 caracteres.',
      );
    }

    // Observación #1: address es REQUIRED por Bridge para cuentas US (ACH/Wire)
    if (
      (dto.payment_rail === 'ach' || dto.payment_rail === 'wire') &&
      !dto.address
    ) {
      throw new BadRequestException(
        'address es obligatoria para transferencias ACH/Wire. Bridge la requiere para validar beneficiary_address_valid.',
      );
    }

    // Bridge exige que street_line_1 en direcciones US incluya un número de calle.
    // Validamos aquí antes de llamar a Bridge para evitar crear una EA huérfana.
    if (
      (dto.payment_rail === 'ach' || dto.payment_rail === 'wire') &&
      dto.address &&
      !/^\d+\s/.test(dto.address.street_line_1?.trim() ?? '')
    ) {
      throw new BadRequestException(
        'La dirección debe incluir un número de calle al inicio de street_line_1 ' +
          '(ej. "123 Main St"). Bridge rechaza direcciones US sin número de calle.',
      );
    }

    // ── Validación temprana para CO Bank Transfer ──
    if (dto.payment_rail === 'co_bank_transfer') {
      if (!dto.account_owner_type) {
        throw new BadRequestException(
          'account_owner_type es obligatorio para CO Bank Transfer (individual o business).',
        );
      }
      if (
        dto.account_owner_type === 'individual' &&
        (!dto.first_name || !dto.last_name)
      ) {
        throw new BadRequestException(
          'first_name y last_name son obligatorios cuando account_owner_type es "individual" para CO Bank Transfer.',
        );
      }
      if (dto.account_owner_type === 'business' && !dto.business_name) {
        throw new BadRequestException(
          'business_name es obligatorio cuando account_owner_type es "business" para CO Bank Transfer.',
        );
      }
    }

    // ── Validación temprana para SEPA (B-4) ──
    if (dto.payment_rail === 'sepa') {
      if (!dto.iban_country) {
        throw new BadRequestException(
          'iban_country es obligatorio para cuentas SEPA (código ISO alpha-3, ej. NLD, DEU, ESP).',
        );
      }
      if (!dto.account_owner_type) {
        throw new BadRequestException(
          'account_owner_type es obligatorio para cuentas SEPA (individual o business).',
        );
      }
      if (dto.account_owner_type === 'business' && !dto.business_name) {
        throw new BadRequestException(
          'business_name es obligatorio cuando account_owner_type es "business".',
        );
      }
      if (
        dto.account_owner_type === 'individual' &&
        (!dto.first_name || !dto.last_name)
      ) {
        throw new BadRequestException(
          'first_name y last_name son obligatorios cuando account_owner_type es "individual".',
        );
      }
    }

    // Derivar account_type de Bridge desde payment_rail
    const bridgeAccountType = this.getBridgeAccountType(dto.payment_rail);

    // ── Construir payload base ──
    const bridgePayload: Record<string, unknown> = {
      account_owner_name: dto.account_owner_name,
      account_type: bridgeAccountType,
      currency: dto.currency,
    };

    // bank_name es opcional
    if (dto.bank_name) {
      bridgePayload.bank_name = dto.bank_name;
    }

    // Helper: convierte código de país alpha-2 → alpha-3 (ISO 3166-1)
    // Bridge requiere alpha-3 en todos los campos "country" de direcciones.
    const toAlpha3 = (code: string | undefined) => this.toAlpha3(code);

    // ── Campos específicos según payment rail ──
    if (dto.payment_rail === 'ach' || dto.payment_rail === 'wire') {
      // US: datos dentro del objeto `account`
      bridgePayload.account = {
        account_number: dto.account_number,
        routing_number: dto.routing_number,
        checking_or_savings: dto.checking_or_savings ?? 'checking',
      };

      // Dirección del beneficiario (recomendada para US)
      if (dto.address) {
        bridgePayload.address = {
          street_line_1: dto.address.street_line_1,
          ...(dto.address.street_line_2
            ? { street_line_2: dto.address.street_line_2 }
            : {}),
          city: dto.address.city,
          ...(dto.address.state ? { state: dto.address.state } : {}),
          ...(dto.address.postal_code
            ? { postal_code: dto.address.postal_code }
            : {}),
          country: this.toAlpha3(dto.address.country), // alpha-2 → alpha-3
        };
      }
    } else if (dto.payment_rail === 'sepa') {
      // IBAN: Bridge espera propiedad raíz "iban" (NO "account")
      bridgePayload.iban = {
        account_number: dto.iban,
        bic: dto.swift_bic,
        // Observación #2: aplicar toAlpha3 para ser consistente con address.country
        country: toAlpha3(dto.iban_country), // obligatorio — garantizado por validación previa
      };

      // owner_type/name fields (opcionales según Bridge, pero recomendados)
      if (dto.account_owner_type) {
        bridgePayload.account_owner_type = dto.account_owner_type;
        if (dto.account_owner_type === 'individual') {
          if (dto.first_name) bridgePayload.first_name = dto.first_name;
          if (dto.last_name) bridgePayload.last_name = dto.last_name;
        } else if (dto.account_owner_type === 'business') {
          if (dto.business_name)
            bridgePayload.business_name = dto.business_name;
        }
      }

      // Dirección del beneficiario (opcional para IBAN)
      if (dto.address) {
        bridgePayload.address = {
          street_line_1: dto.address.street_line_1,
          ...(dto.address.street_line_2
            ? { street_line_2: dto.address.street_line_2 }
            : {}),
          city: dto.address.city,
          ...(dto.address.state ? { state: dto.address.state } : {}),
          ...(dto.address.postal_code
            ? { postal_code: dto.address.postal_code }
            : {}),
          country: toAlpha3(dto.address.country), // ← FIX: alpha-2 → alpha-3
        };
      }
    } else if (dto.payment_rail === 'spei') {
      // CLABE (México): Bridge espera propiedad raíz "clabe" con "account_number"
      bridgePayload.clabe = {
        account_number: dto.clabe,
      };

      // owner info (opcional pero recomendado según ejemplos Bridge)
      if (dto.account_owner_type) {
        bridgePayload.account_owner_type = dto.account_owner_type;
        if (dto.account_owner_type === 'individual') {
          if (dto.first_name) bridgePayload.first_name = dto.first_name;
          if (dto.last_name) bridgePayload.last_name = dto.last_name;
        } else if (dto.account_owner_type === 'business') {
          if (dto.business_name)
            bridgePayload.business_name = dto.business_name;
        }
      }

      // Dirección (opcional)
      if (dto.address) {
        bridgePayload.address = {
          street_line_1: dto.address.street_line_1,
          ...(dto.address.street_line_2
            ? { street_line_2: dto.address.street_line_2 }
            : {}),
          city: dto.address.city,
          ...(dto.address.state ? { state: dto.address.state } : {}),
          ...(dto.address.postal_code
            ? { postal_code: dto.address.postal_code }
            : {}),
          country: toAlpha3(dto.address.country), // ← FIX: alpha-2 → alpha-3
        };
      }
    } else if (dto.payment_rail === 'pix') {
      // PIX (Brasil): Bridge distingue "pix_key" y "br_code" como propiedades raíz
      if (!dto.pix_key && !dto.br_code) {
        throw new BadRequestException(
          'PIX requiere pix_key o br_code — al menos uno debe estar presente.',
        );
      }
      if (dto.pix_key) {
        bridgePayload.pix_key = {
          pix_key: dto.pix_key,
          ...(dto.document_number
            ? { document_number: dto.document_number }
            : {}),
        };
      } else if (dto.br_code) {
        bridgePayload.br_code = {
          br_code: dto.br_code,
          ...(dto.document_number
            ? { document_number: dto.document_number }
            : {}),
        };
      }

      // owner info (opcional pero recomendado según ejemplos Bridge)
      if (dto.account_owner_type) {
        bridgePayload.account_owner_type = dto.account_owner_type;
        if (dto.account_owner_type === 'individual') {
          if (dto.first_name) bridgePayload.first_name = dto.first_name;
          if (dto.last_name) bridgePayload.last_name = dto.last_name;
        } else if (dto.account_owner_type === 'business') {
          if (dto.business_name)
            bridgePayload.business_name = dto.business_name;
        }
      }

      // Dirección (opcional)
      if (dto.address) {
        bridgePayload.address = {
          street_line_1: dto.address.street_line_1,
          ...(dto.address.street_line_2
            ? { street_line_2: dto.address.street_line_2 }
            : {}),
          city: dto.address.city,
          ...(dto.address.state ? { state: dto.address.state } : {}),
          ...(dto.address.postal_code
            ? { postal_code: dto.address.postal_code }
            : {}),
          country: toAlpha3(dto.address.country), // ← FIX: alpha-2 → alpha-3
        };
      }
    } else if (dto.payment_rail === 'bre_b') {
      // Bre-B (Colombia): Bridge espera propiedad raíz "account" con "bre_b_key"
      bridgePayload.account = {
        bre_b_key: dto.bre_b_key,
      };
    } else if (dto.payment_rail === 'faster_payments') {
      // FPS — Faster Payments (Reino Unido): account_number 8 dígitos + sort_code 6 dígitos
      if (!dto.account_number || dto.account_number.length !== 8) {
        throw new BadRequestException(
          'Faster Payments requiere account_number de exactamente 8 dígitos.',
        );
      }
      if (!dto.sort_code || dto.sort_code.length !== 6) {
        throw new BadRequestException(
          'Faster Payments requiere sort_code de exactamente 6 dígitos (sin guiones).',
        );
      }
      bridgePayload.account = {
        account_number: dto.account_number,
        sort_code: dto.sort_code,
      };

      if (dto.account_owner_type) {
        bridgePayload.account_owner_type = dto.account_owner_type;
        if (dto.account_owner_type === 'individual') {
          if (dto.first_name) bridgePayload.first_name = dto.first_name;
          if (dto.last_name) bridgePayload.last_name = dto.last_name;
        } else if (dto.account_owner_type === 'business') {
          if (dto.business_name)
            bridgePayload.business_name = dto.business_name;
        }
      }

      if (dto.address) {
        bridgePayload.address = {
          street_line_1: dto.address.street_line_1,
          ...(dto.address.street_line_2
            ? { street_line_2: dto.address.street_line_2 }
            : {}),
          city: dto.address.city,
          ...(dto.address.state ? { state: dto.address.state } : {}),
          ...(dto.address.postal_code
            ? { postal_code: dto.address.postal_code }
            : {}),
          country: toAlpha3(dto.address.country),
        };
      }
    } else if (dto.payment_rail === 'co_bank_transfer') {
      // CO Bank Transfer (Colombia): cuenta bancaria tradicional con datos completos
      if (
        !dto.account_number ||
        !dto.bank_code ||
        !dto.document_type ||
        !dto.document_number ||
        !dto.phone_number
      ) {
        throw new BadRequestException(
          'CO Bank Transfer requiere: account_number, bank_code, document_type, document_number y phone_number.',
        );
      }
      bridgePayload.account = {
        account_number: dto.account_number,
        bank_code: dto.bank_code,
        account_type: dto.checking_or_savings ?? 'savings',
        document_type: dto.document_type,
        document_number: dto.document_number,
        phone_number: dto.phone_number,
      };

      if (dto.account_owner_type) {
        bridgePayload.account_owner_type = dto.account_owner_type;
        if (dto.account_owner_type === 'individual') {
          if (dto.first_name) bridgePayload.first_name = dto.first_name;
          if (dto.last_name) bridgePayload.last_name = dto.last_name;
        } else if (dto.account_owner_type === 'business') {
          if (dto.business_name)
            bridgePayload.business_name = dto.business_name;
        }
      }
    }

    // ── Llamar Bridge API ──
    const bridgeEA = await this.bridgeApi.post<Record<string, unknown>>(
      `/v0/customers/${profile.bridge_customer_id}/external_accounts`,
      bridgePayload,
      `ea-${userId}-${Date.now()}`,
    );

    // Extraer datos de respuesta de Bridge (la estructura varía por rail)
    const bridgeAccount = bridgeEA.account as
      | Record<string, unknown>
      | undefined;
    const bridgeIban = bridgeEA.iban as Record<string, unknown> | undefined;
    const bridgeClabe = bridgeEA.clabe as Record<string, unknown> | undefined;
    const bridgePixKey = bridgeEA.pix_key as
      | Record<string, unknown>
      | undefined;
    const bridgeBrCode = bridgeEA.br_code as
      | Record<string, unknown>
      | undefined;

    // ── Guardar en DB ──
    const { data, error } = await this.supabase
      .from('bridge_external_accounts')
      .insert({
        user_id: userId,
        bridge_external_account_id: bridgeEA.id,
        bridge_customer_id: profile.bridge_customer_id,
        bank_name: dto.bank_name ?? (bridgeEA.bank_name as string) ?? null,
        account_name: dto.account_owner_name,
        account_last_4:
          (bridgeAccount?.last_4 as string) ??
          (bridgeIban?.last_4 as string) ??
          (bridgeClabe?.last_4 as string) ??
          (bridgePixKey?.account_preview as string)?.slice(-4) ??
          (bridgeBrCode?.account_preview as string)?.slice(-4) ??
          (
            dto.account_number ??
            dto.iban ??
            dto.clabe ??
            dto.pix_key ??
            dto.br_code ??
            dto.bre_b_key ??
            ''
          ).slice(-4),
        currency: dto.currency.toLowerCase(),
        payment_rail: dto.payment_rail,
        account_type: dto.checking_or_savings ?? null,
        routing_number: dto.routing_number ?? null,
        iban: dto.iban ?? null,
        swift_bic: dto.swift_bic ?? null,
        is_active: (bridgeEA.active as boolean) ?? true,
        // Nuevos campos de la respuesta de Bridge
        beneficiary_address_valid:
          (bridgeEA.beneficiary_address_valid as boolean) ?? null,
        account_owner_type: dto.account_owner_type ?? null,
        first_name: dto.first_name ?? null,
        last_name: dto.last_name ?? null,
        business_name: dto.business_name ?? null,
      })
      .select()
      .single();

    if (error) throwDbError(error);
    return data;
  }

  /**
   * Actualiza una External Account en Bridge.
   *
   * Según la documentación de Bridge (PUT /external_accounts/{id}):
   * - `address` es REQUERIDO (dirección del beneficiario)
   * - `account` es OPCIONAL y solo aplica para cuentas US (routing_number, checking_or_savings)
   *
   * Los campos bancarios inmutables (account_number, iban, clabe, pix_key, etc.)
   * NO pueden actualizarse; Bridge requiere crear una nueva External Account.
   */
  async updateExternalAccount(
    userId: string,
    bridgeEaDbId: string,
    updatePayload: {
      address: {
        street_line_1: string;
        street_line_2?: string;
        city: string;
        state?: string;
        postal_code?: string;
        country: string;
      };
      account?: {
        routing_number?: string;
        checking_or_savings?: 'checking' | 'savings';
      };
    },
  ) {
    const profile = await this.getVerifiedProfile(userId);

    // Obtener el bridge_external_account_id real (UUID de Bridge)
    const { data: eaRecord, error: eaError } = await this.supabase
      .from('bridge_external_accounts')
      .select('bridge_external_account_id')
      .eq('id', bridgeEaDbId)
      .eq('user_id', userId)
      .single();

    if (eaError || !eaRecord) {
      throw new NotFoundException(
        'External Account no encontrada en la DB local',
      );
    }

    // Usa el helper compartido toAlpha3 para address.country

    // Construir payload para Bridge PUT
    const bridgePayload: Record<string, unknown> = {
      address: {
        street_line_1: updatePayload.address.street_line_1,
        ...(updatePayload.address.street_line_2
          ? { street_line_2: updatePayload.address.street_line_2 }
          : {}),
        city: updatePayload.address.city,
        ...(updatePayload.address.state
          ? { state: updatePayload.address.state }
          : {}),
        ...(updatePayload.address.postal_code
          ? { postal_code: updatePayload.address.postal_code }
          : {}),
        country: this.toAlpha3(updatePayload.address.country),
      },
    };

    // Solo US: agregar account si hay campos
    if (updatePayload.account) {
      const accountFields: Record<string, unknown> = {};
      if (updatePayload.account.routing_number) {
        accountFields.routing_number = updatePayload.account.routing_number;
      }
      if (updatePayload.account.checking_or_savings) {
        accountFields.checking_or_savings =
          updatePayload.account.checking_or_savings;
      }
      if (Object.keys(accountFields).length > 0) {
        bridgePayload.account = accountFields;
      }
    }

    const bridgeResponse = await this.bridgeApi.put<Record<string, unknown>>(
      `/v0/customers/${profile.bridge_customer_id}/external_accounts/${eaRecord.bridge_external_account_id}`,
      bridgePayload,
    );

    // Actualizar beneficiary_address_valid en DB local si Bridge lo devuelve
    if (bridgeResponse.beneficiary_address_valid !== undefined) {
      await this.supabase
        .from('bridge_external_accounts')
        .update({
          beneficiary_address_valid: bridgeResponse.beneficiary_address_valid,
        })
        .eq('id', bridgeEaDbId);
    }

    this.logger.log(
      `External Account ${eaRecord.bridge_external_account_id} actualizada en Bridge`,
    );

    return bridgeResponse;
  }

  /**
   * Elimina una External Account de Bridge y la marca como inactiva en DB.
   * Se usa como rollback cuando la creación de la liquidation address falla
   * justo después de que la EA fue creada exitosamente en Bridge, evitando
   * que quede una EA huérfana que bloquee futuros reintentos del usuario.
   */
  async deleteExternalAccount(userId: string, bridgeEaDbId: string): Promise<void> {
    const { data: eaRecord } = await this.supabase
      .from('bridge_external_accounts')
      .select('bridge_external_account_id, bridge_customer_id')
      .eq('id', bridgeEaDbId)
      .eq('user_id', userId)
      .single();

    if (!eaRecord) {
      this.logger.warn(
        `deleteExternalAccount: EA ${bridgeEaDbId} no encontrada en DB para user ${userId} — se omite rollback`,
      );
      return;
    }

    try {
      await this.bridgeApi.delete(
        `/v0/customers/${eaRecord.bridge_customer_id}/external_accounts/${eaRecord.bridge_external_account_id}`,
      );
      this.logger.log(
        `deleteExternalAccount: EA ${eaRecord.bridge_external_account_id} eliminada de Bridge`,
      );
    } catch (err) {
      this.logger.warn(
        `deleteExternalAccount: Bridge DELETE falló para EA ${eaRecord.bridge_external_account_id}: ${err.message}`,
      );
    }

    await this.supabase
      .from('bridge_external_accounts')
      .update({ is_active: false })
      .eq('id', bridgeEaDbId)
      .eq('user_id', userId);
  }

  /** Lista cuentas externas activas. */
  async listExternalAccounts(userId: string) {
    const { data, error } = await this.supabase
      .from('bridge_external_accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true);

    if (error) throwDbError(error);
    return data ?? [];
  }

  /** Desactiva cuenta externa. */
  async deactivateExternalAccount(eaId: string, userId: string) {
    const { data: ea } = await this.supabase
      .from('bridge_external_accounts')
      .select('bridge_external_account_id')
      .eq('id', eaId)
      .eq('user_id', userId)
      .single();

    if (!ea) throw new NotFoundException('Cuenta externa no encontrada');

    await this.supabase
      .from('bridge_external_accounts')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', eaId);

    return { message: 'Cuenta externa desactivada' };
  }

  // ═══════════════════════════════════════════════════
  //  PAYOUTS (pagos salientes — refactor completo)
  // ═══════════════════════════════════════════════════

  /** Crea solicitud de pago con validación completa y reserva de saldo. */
  async createPayout(userId: string, dto: CreatePayoutRequestDto) {
    // 1. Validar perfil
    const profile = await this.getVerifiedProfile(userId);

    // 2. Calcular fee
    const { fee_amount, net_amount } = await this.feesService.calculateFee(
      userId,
      'payout',
      dto.payment_rail,
      dto.currency ?? 'usd',
      dto.amount,
    );
    const totalAmount = dto.amount + fee_amount;

    // 3. Verificar saldo
    const { data: balance } = await this.supabase
      .from('balances')
      .select('available_amount')
      .eq('user_id', userId)
      .eq('currency', dto.currency.toUpperCase())
      .single();

    const available = parseFloat(balance?.available_amount ?? '0');
    if (available < totalAmount) {
      throw new BadRequestException(
        `Saldo insuficiente. Disponible: ${available}, Requerido: ${totalAmount} (monto ${dto.amount} + fee ${fee_amount})`,
      );
    }

    // 4. Verificar límites de transacción
    await this.verifyTransactionLimits(userId, dto.amount);

    // 5. Reservar saldo
    await this.supabase.rpc('reserve_balance', {
      p_user_id: userId,
      p_currency: dto.currency.toUpperCase(),
      p_amount: totalAmount,
    });

    // 6. Crear payout_request
    const idempotencyKey = `payout-${userId}-${Date.now()}-${crypto.randomUUID()}`;

    const { data: payoutReq, error } = await this.supabase
      .from('payout_requests')
      .insert({
        user_id: userId,
        wallet_id: dto.wallet_id,
        bridge_external_account_id: dto.bridge_external_account_id ?? null,
        supplier_id: dto.supplier_id ?? null,
        payment_rail: dto.payment_rail,
        amount: dto.amount,
        fee_amount,
        net_amount,
        currency: dto.currency.toUpperCase(),
        idempotency_key: idempotencyKey,
        business_purpose: dto.business_purpose,
        notes: dto.notes ?? null,
        status: 'pending',
      })
      .select()
      .single();

    if (error) {
      // Liberar saldo si falla
      await this.releaseReservedBalance(userId, dto.currency, totalAmount);
      throwDbError(error);
    }

    // 7. ¿Requiere revisión de compliance?
    const threshold = await this.getPayoutReviewThreshold();
    if (dto.amount >= threshold) {
      await this.createComplianceReview('payout_request', payoutReq.id, userId);
      return { ...payoutReq, requires_review: true };
    }

    // 8. Auto-aprobar → ejecutar en Bridge
    return this.executePayout(payoutReq.id, profile.bridge_customer_id);
  }

  /** Ejecuta un payout aprobado en Bridge API. */
  async executePayout(payoutRequestId: string, bridgeCustomerId: string) {
    const { data: req, error: reqErr } = await this.supabase
      .from('payout_requests')
      .select('*')
      .eq('id', payoutRequestId)
      .single();

    if (reqErr || !req)
      throw new NotFoundException('Payout request no encontrado');

    // Obtener wallet address y provider_wallet_id (Bridge Wallet ID)
    const { data: wallet } = await this.supabase
      .from('wallets')
      .select('address, provider_wallet_id')
      .eq('id', req.wallet_id)
      .single();

    // Obtener external account ID de Bridge
    let externalAccountBridgeId: string | undefined;
    if (req.bridge_external_account_id) {
      const { data: ea } = await this.supabase
        .from('bridge_external_accounts')
        .select('bridge_external_account_id')
        .eq('id', req.bridge_external_account_id)
        .single();
      externalAccountBridgeId = ea?.bridge_external_account_id;
    }

    // Llamar Bridge Transfer API
    let bridgeTransfer: Record<string, unknown>;
    try {
      bridgeTransfer = await this.bridgeApi.post<Record<string, unknown>>(
        '/v0/transfers',
        {
          on_behalf_of: bridgeCustomerId,
          source: {
            payment_rail: 'bridge_wallet',
            currency: req.currency.toLowerCase(),
            bridge_wallet_id: wallet?.provider_wallet_id,
          },
          destination: {
            payment_rail: req.payment_rail,
            currency: req.currency.toLowerCase(),
            external_account_id: externalAccountBridgeId,
          },
          amount: req.amount.toString(),
          developer_fee: (req.fee_amount ?? '0').toString(),
          return_instructions: {
            address: wallet?.address,
          },
        },
        req.idempotency_key,
      );
    } catch (err) {
      // Liberar saldo reservado si Bridge falla
      const totalAmount =
        parseFloat(req.amount) + parseFloat(req.fee_amount ?? '0');
      await this.releaseReservedBalance(req.user_id, req.currency, totalAmount);

      await this.supabase
        .from('payout_requests')
        .update({ status: 'failed' })
        .eq('id', req.id);

      throw err;
    }

    // Guardar bridge_transfer
    await this.supabase.from('bridge_transfers').insert({
      user_id: req.user_id,
      payout_request_id: req.id,
      bridge_transfer_id: bridgeTransfer.id,
      idempotency_key: req.idempotency_key,
      amount: req.amount,
      net_amount: req.net_amount,
      bridge_state: bridgeTransfer.state ?? 'payment_submitted',
      status: 'processing',
      source_payment_rail: 'usdc',
      destination_payment_rail: req.payment_rail,
      destination_currency: req.currency,
      bridge_raw_response: bridgeTransfer,
    });

    // Ledger entry como PENDING (NO settled)
    await this.ledgerService.createEntry({
      wallet_id: req.wallet_id,
      type: 'debit',
      amount: parseFloat(req.amount) + parseFloat(req.fee_amount ?? '0'),
      currency: req.currency,
      status: 'pending',
      reference_type: 'payout_request',
      reference_id: req.id,
      bridge_transfer_id: bridgeTransfer.id as string,
      description: `Pago en proceso — ${req.business_purpose}`,
    });

    // Actualizar payout_request
    await this.supabase
      .from('payout_requests')
      .update({
        status: 'processing',
        bridge_transfer_id: bridgeTransfer.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.id);

    return {
      payout_request_id: req.id,
      bridge_transfer_id: bridgeTransfer.id,
      status: 'processing',
    };
  }

  /** Lista payout requests del usuario. */
  async listPayoutRequests(userId: string) {
    const { data, error } = await this.supabase
      .from('payout_requests')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throwDbError(error);
    return data ?? [];
  }

  /** Detalle de un payout request. */
  async getPayoutRequest(payoutId: string, userId: string) {
    const { data, error } = await this.supabase
      .from('payout_requests')
      .select('*')
      .eq('id', payoutId)
      .eq('user_id', userId)
      .single();

    if (error || !data)
      throw new NotFoundException('Payout request no encontrado');
    return data;
  }

  /** Admin: aprueba un payout pendiente. */
  async approvePayout(payoutId: string, actorId: string) {
    const { data: req } = await this.supabase
      .from('payout_requests')
      .select('*, profiles!payout_requests_user_id_fkey(bridge_customer_id)')
      .eq('id', payoutId)
      .eq('status', 'pending')
      .single();

    if (!req) throw new NotFoundException('Payout pendiente no encontrado');

    const bridgeCustomerId = (
      req.profiles as unknown as { bridge_customer_id: string }
    )?.bridge_customer_id;

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: 'admin',
      action: 'payout_approved',
      table_name: 'payout_requests',
      record_id: payoutId,
      new_values: { amount: req.amount, currency: req.currency },
      source: 'admin_panel',
    });

    return this.executePayout(payoutId, bridgeCustomerId);
  }

  /** Admin: rechaza un payout pendiente (libera saldo). */
  async rejectPayout(payoutId: string, reason: string, actorId: string) {
    const { data: req } = await this.supabase
      .from('payout_requests')
      .select('*')
      .eq('id', payoutId)
      .eq('status', 'pending')
      .single();

    if (!req) throw new NotFoundException('Payout pendiente no encontrado');

    const totalAmount =
      parseFloat(req.amount) + parseFloat(req.fee_amount ?? '0');
    await this.releaseReservedBalance(req.user_id, req.currency, totalAmount);

    await this.supabase
      .from('payout_requests')
      .update({
        status: 'rejected',
        notes: reason,
        updated_at: new Date().toISOString(),
      })
      .eq('id', payoutId);

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: 'admin',
      action: 'payout_rejected',
      table_name: 'payout_requests',
      record_id: payoutId,
      new_values: { reason, amount: req.amount },
      source: 'admin_panel',
    });

    return { message: 'Payout rechazado, saldo liberado' };
  }

  // ═══════════════════════════════════════════════════
  //  TRANSFERS (consultas)
  // ═══════════════════════════════════════════════════

  async listTransfers(userId: string) {
    const { data, error } = await this.supabase
      .from('bridge_transfers')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throwDbError(error);
    return data ?? [];
  }

  /** Admin: lista TODAS las transferencias Bridge (sin filtro de usuario). */
  async listAllTransfers(filters?: {
    status?: string;
    limit?: number;
    offset?: number;
    dateFrom?: string;
    dateTo?: string;
    sourceRail?: string;
    destRail?: string;
    callerRole?: string;
  }) {
    const pageSize = Math.min(filters?.limit ?? 100, 200);
    const pageOffset = Math.max(filters?.offset ?? 0, 0);

    // Query de datos (con JOIN de perfiles)
    let dataQuery = this.supabase
      .from('bridge_transfers')
      .select('*, profiles!bridge_transfers_user_id_fkey(email, full_name)')
      .order('created_at', { ascending: false })
      .range(pageOffset, pageOffset + pageSize - 1);

    // Query de count separada (sin JOIN para mayor compatibilidad)
    let countQuery = this.supabase
      .from('bridge_transfers')
      .select('*', { count: 'exact', head: true });

    if (filters?.status && filters.status !== 'all') {
      dataQuery = dataQuery.eq('status', filters.status);
      countQuery = countQuery.eq('status', filters.status);
    }

    if (filters?.dateFrom) {
      dataQuery = dataQuery.gte('created_at', filters.dateFrom);
      countQuery = countQuery.gte('created_at', filters.dateFrom);
    }

    if (filters?.dateTo) {
      dataQuery = dataQuery.lt('created_at', filters.dateTo);
      countQuery = countQuery.lt('created_at', filters.dateTo);
    }

    if (filters?.sourceRail && filters.sourceRail !== 'all') {
      dataQuery = dataQuery.eq('source_payment_rail', filters.sourceRail);
      countQuery = countQuery.eq('source_payment_rail', filters.sourceRail);
    }

    if (filters?.destRail && filters.destRail !== 'all') {
      dataQuery = dataQuery.eq('destination_payment_rail', filters.destRail);
      countQuery = countQuery.eq('destination_payment_rail', filters.destRail);
    }

    const [{ data, error }, { count, error: countError }] = await Promise.all([
      dataQuery,
      countQuery,
    ]);

    if (error) throwDbError(error);
    if (countError) throw new BadRequestException(countError.message);

    // bridge_raw_response contiene datos sensibles de Bridge API (cuentas bancarias, hashes).
    // Solo se incluye en la respuesta para super_admin.
    const includeSensitive = filters?.callerRole === 'super_admin';

    const items = (data ?? []).map((t: any) => {
      const item = {
        ...t,
        user_email: t.profiles?.email ?? null,
        user_full_name: t.profiles?.full_name ?? null,
        profiles: undefined,
      };
      if (!includeSensitive) {
        item.bridge_raw_response = undefined;
      }
      return item;
    });

    return {
      items,
      total: count ?? items.length,
      limit: pageSize,
      offset: pageOffset,
    };
  }

  async getTransfer(transferId: string, userId: string) {
    const { data, error } = await this.supabase
      .from('bridge_transfers')
      .select('*')
      .eq('id', transferId)
      .eq('user_id', userId)
      .single();

    if (error || !data)
      throw new NotFoundException('Transferencia no encontrada');
    return data;
  }

  async syncTransferFromBridge(transferId: string, userId: string) {
    const { data: transfer } = await this.supabase
      .from('bridge_transfers')
      .select('bridge_transfer_id')
      .eq('id', transferId)
      .eq('user_id', userId)
      .single();

    if (!transfer) throw new NotFoundException('Transferencia no encontrada');

    const bridgeData = await this.bridgeApi.get<Record<string, unknown>>(
      `/v0/transfers/${transfer.bridge_transfer_id}`,
    );

    await this.supabase
      .from('bridge_transfers')
      .update({
        bridge_state: bridgeData.state,
        bridge_raw_response: bridgeData,
        updated_at: new Date().toISOString(),
      })
      .eq('id', transferId);

    return { synced: true, state: bridgeData.state };
  }

  // ═══════════════════════════════════════════════════
  //  LIQUIDATION ADDRESSES
  // ═══════════════════════════════════════════════════

  async createLiquidationAddress(
    userId: string,
    dto: CreateLiquidationAddressDto,
  ) {
    const profile = await this.getVerifiedProfile(userId);

    // Resolver fee: si el caller ya lo provee lo usamos; si no, lo consultamos
    // desde fees_config respetando overrides del usuario.
    // - destino crypto (wallet)         → operation_type: interbank_bo_wallet
    // - destino fiat (external account) → operation_type: interbank_bo_out
    // Rail siempre 'psav' (el cliente siempre deposita BOB vía PSAV).
    // Currency = divisa DESTINO de la liquidation address: permite tasas distintas
    // por moneda de liquidación (USD, EUR, MXN, USDC, USDT, etc.).
    let developerFeePercent: string | undefined =
      dto.custom_developer_fee_percent;
    if (!developerFeePercent) {
      const isCryptoDestination = !!dto.destination_address;
      developerFeePercent = await this.feesService.getFeePercent(
        userId,
        isCryptoDestination ? 'interbank_bo_wallet' : 'interbank_bo_out',
        'psav',
        dto.destination_currency.toLowerCase(),
      );
    }

    const bridgeLA = await this.bridgeApi.post<Record<string, unknown>>(
      `/v0/customers/${profile.bridge_customer_id}/liquidation_addresses`,
      {
        currency: dto.currency,
        chain: dto.chain,
        destination_currency: dto.destination_currency,
        destination_payment_rail: dto.destination_payment_rail,
        ...(dto.external_account_id
          ? { external_account_id: dto.external_account_id }
          : {}),
        ...(dto.destination_address
          ? { destination_address: dto.destination_address }
          : {}),
        ...(dto.destination_sepa_reference
          ? { destination_sepa_reference: dto.destination_sepa_reference }
          : {}),
        ...(dto.destination_wire_message
          ? { destination_wire_message: dto.destination_wire_message }
          : {}),
        ...(dto.destination_ach_reference
          ? { destination_ach_reference: dto.destination_ach_reference }
          : {}),
        ...(dto.destination_spei_reference
          ? { destination_spei_reference: dto.destination_spei_reference }
          : {}),
        ...(dto.destination_reference
          ? { destination_reference: dto.destination_reference }
          : {}),
        ...(developerFeePercent !== undefined && developerFeePercent !== null
          ? { custom_developer_fee_percent: developerFeePercent }
          : {}),
      },
      `la-${userId}-${dto.currency}-${dto.chain}-${Date.now()}`,
    );

    const { data, error } = await this.supabase
      .from('bridge_liquidation_addresses')
      .insert({
        user_id: userId,
        bridge_liquidation_address_id: bridgeLA.id as string,
        bridge_customer_id: profile.bridge_customer_id,
        chain: bridgeLA.chain as string,
        currency: bridgeLA.currency as string,
        address: (bridgeLA.address as string) ?? null,
        destination_payment_rail:
          (bridgeLA.destination_payment_rail as string) ??
          dto.destination_payment_rail,
        destination_currency:
          (bridgeLA.destination_currency as string) ?? dto.destination_currency,
        destination_external_account_id: dto.external_account_id ?? null,
        destination_address: dto.destination_address ?? null,
        developer_fee_percent:
          bridgeLA.custom_developer_fee_percent !== undefined
            ? bridgeLA.custom_developer_fee_percent ?? null
            : developerFeePercent ?? null,
        is_active: true,
      })
      .select()
      .single();

    if (error) {
      this.logger.error(
        `Error guardando liquidation address en DB para usuario ${userId}: ${error.message}`,
      );
      throw new BadRequestException(
        `Liquidation address creada en Bridge pero no pudo guardarse localmente: ${error.message}`,
      );
    }

    return data;
  }

  async listLiquidationAddresses(userId: string) {
    const profile = await this.getVerifiedProfile(userId);
    return this.bridgeApi.get(
      `/v0/customers/${profile.bridge_customer_id}/liquidation_addresses`,
    );
  }

  async listLiquidationAddressesByUserAdmin(userId: string) {
    const { data, error } = await this.supabase
      .from('bridge_liquidation_addresses')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);

    const liquidationAddresses = data ?? [];
    const destinationExternalAccountIds = Array.from(
      new Set(
        liquidationAddresses
          .map((address) => address.destination_external_account_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    );

    if (destinationExternalAccountIds.length === 0) {
      return liquidationAddresses.map((address) => ({
        ...address,
        destination_external_account: null,
      }));
    }

    const { data: externalAccounts, error: externalAccountsError } =
      await this.supabase
        .from('bridge_external_accounts')
        .select(
          'bridge_external_account_id, bank_name, account_name, account_last_4, currency, payment_rail, account_type, routing_number, country, is_active',
        )
        .eq('user_id', userId)
        .in('bridge_external_account_id', destinationExternalAccountIds);

    if (externalAccountsError) {
      this.logger.warn(
        `No se pudieron cargar cuentas externas destino para liquidation addresses del usuario ${userId}: ${externalAccountsError.message}`,
      );

      return liquidationAddresses.map((address) => ({
        ...address,
        destination_external_account: null,
      }));
    }

    const externalAccountByBridgeId = new Map(
      (externalAccounts ?? []).map((account) => [
        account.bridge_external_account_id,
        account,
      ]),
    );

    return liquidationAddresses.map((address) => ({
      ...address,
      destination_external_account: address.destination_external_account_id
        ? (externalAccountByBridgeId.get(address.destination_external_account_id) ??
          null)
        : null,
    }));
  }

  /**
   * Actualiza una Liquidation Address en Bridge y sincroniza la DB local
   * con la respuesta confirmada de Bridge (fuente de verdad).
   *
   * Flujo: PUT Bridge → Bridge responde 200 con LA actualizada → sync DB.
   * Campos editables según la API de Bridge:
   *   external_account_id, custom_developer_fee_percent,
   *   destination_ach_reference, destination_wire_message,
   *   destination_sepa_reference, destination_spei_reference,
   *   destination_reference, return_address
   */
  async updateLiquidationAddress(
    userId: string,
    bridgeLaDbId: string,
    updatePayload: {
      external_account_id?: string;
      custom_developer_fee_percent?: string | null;
      destination_ach_reference?: string;
      destination_wire_message?: string;
      destination_sepa_reference?: string;
      destination_spei_reference?: string;
      destination_reference?: string;
      return_address?: string;
    },
  ) {
    const profile = await this.getVerifiedProfile(userId);

    const { data: laRecord, error: laError } = await this.supabase
      .from('bridge_liquidation_addresses')
      .select('bridge_liquidation_address_id')
      .eq('id', bridgeLaDbId)
      .eq('user_id', userId)
      .single();

    if (laError || !laRecord) {
      throw new NotFoundException(
        'Liquidation Address no encontrada en la DB local',
      );
    }

    if (updatePayload.custom_developer_fee_percent === null) {
      const { data: linkedSupplier } = await this.supabase
        .from('suppliers')
        .select('id')
        .eq('user_id', userId)
        .eq(
          'bridge_liquidation_address_id',
          laRecord.bridge_liquidation_address_id,
        )
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();

      if (linkedSupplier) {
        throw new BadRequestException(
          'No se puede dejar en null el developer fee de una liquidation address usada por proveedores. Define un porcentaje explícito para evitar discrepancias contables.',
        );
      }
    }

    // Construir payload — solo campos explícitamente enviados
    const bridgePayload: Record<string, unknown> = {};
    if (updatePayload.external_account_id !== undefined)
      bridgePayload.external_account_id = updatePayload.external_account_id;
    if (updatePayload.custom_developer_fee_percent !== undefined)
      bridgePayload.custom_developer_fee_percent = updatePayload.custom_developer_fee_percent;
    if (updatePayload.destination_ach_reference !== undefined)
      bridgePayload.destination_ach_reference = updatePayload.destination_ach_reference;
    if (updatePayload.destination_wire_message !== undefined)
      bridgePayload.destination_wire_message = updatePayload.destination_wire_message;
    if (updatePayload.destination_sepa_reference !== undefined)
      bridgePayload.destination_sepa_reference = updatePayload.destination_sepa_reference;
    if (updatePayload.destination_spei_reference !== undefined)
      bridgePayload.destination_spei_reference = updatePayload.destination_spei_reference;
    if (updatePayload.destination_reference !== undefined)
      bridgePayload.destination_reference = updatePayload.destination_reference;
    if (updatePayload.return_address !== undefined)
      bridgePayload.return_address = updatePayload.return_address;

    if (Object.keys(bridgePayload).length === 0) {
      this.logger.warn(
        `updateLiquidationAddress llamado sin campos a actualizar para LA ${bridgeLaDbId}`,
      );
      return null;
    }

    // 1. Enviar PUT a Bridge — su respuesta 200 es la confirmación
    const bridgeResponse = await this.bridgeApi.put<Record<string, unknown>>(
      `/v0/customers/${profile.bridge_customer_id}/liquidation_addresses/${laRecord.bridge_liquidation_address_id}`,
      bridgePayload,
    );

    // 2. Solo si Bridge confirmó el update, sincronizar DB local con los datos
    //    que Bridge devolvió (fuente de verdad), no con los valores de input.
    const dbSync: Record<string, unknown> = {};
    if (bridgeResponse.external_account_id !== undefined)
      dbSync.destination_external_account_id = bridgeResponse.external_account_id ?? null;
    if (bridgeResponse.custom_developer_fee_percent !== undefined)
      dbSync.developer_fee_percent = bridgeResponse.custom_developer_fee_percent ?? null;
    if (bridgeResponse.destination_address !== undefined)
      dbSync.destination_address = bridgeResponse.destination_address ?? null;
    if (bridgeResponse.destination_ach_reference !== undefined)
      dbSync.destination_ach_reference = bridgeResponse.destination_ach_reference ?? null;
    if (bridgeResponse.destination_wire_message !== undefined)
      dbSync.destination_wire_message = bridgeResponse.destination_wire_message ?? null;
    if (bridgeResponse.destination_sepa_reference !== undefined)
      dbSync.destination_sepa_reference = bridgeResponse.destination_sepa_reference ?? null;
    if (bridgeResponse.destination_spei_reference !== undefined)
      dbSync.destination_spei_reference = bridgeResponse.destination_spei_reference ?? null;
    if (bridgeResponse.destination_reference !== undefined)
      dbSync.destination_reference = bridgeResponse.destination_reference ?? null;

    if (Object.keys(dbSync).length > 0) {
      const { error: dbError } = await this.supabase
        .from('bridge_liquidation_addresses')
        .update(dbSync)
        .eq('id', bridgeLaDbId);

      if (dbError) {
        this.logger.error(
          `Bridge confirmó el update pero falló la sync de DB para LA ${bridgeLaDbId}: ${dbError.message}`,
        );
      }
    }

    this.logger.log(
      `Liquidation Address ${laRecord.bridge_liquidation_address_id} actualizada en Bridge y DB sincronizada`,
    );

    return bridgeResponse;
  }

  /**
   * Versión admin de updateLiquidationAddress.
   * El actor es staff/admin, pero el userId pertenece al cliente dueño de la LA.
   */
  async updateLiquidationAddressAdmin(
    targetUserId: string,
    bridgeLaDbId: string,
    updatePayload: {
      external_account_id?: string;
      custom_developer_fee_percent?: string | null;
      destination_ach_reference?: string;
      destination_wire_message?: string;
      destination_sepa_reference?: string;
      destination_spei_reference?: string;
      destination_reference?: string;
      return_address?: string;
    },
    actorId: string,
    actorRole: string,
    reason: string,
  ) {
    // Capturar valores previos antes de enviar a Bridge
    const { data: previous } = await this.supabase
      .from('bridge_liquidation_addresses')
      .select(
        'destination_external_account_id, developer_fee_percent, destination_ach_reference, destination_wire_message, destination_sepa_reference, destination_spei_reference, destination_reference, destination_address',
      )
      .eq('id', bridgeLaDbId)
      .single();

    const result = await this.updateLiquidationAddress(targetUserId, bridgeLaDbId, updatePayload);

    if (result !== null) {
      await this.supabase.from('audit_logs').insert({
        performed_by: actorId,
        role: actorRole,
        action: 'UPDATE_LIQUIDATION_ADDRESS',
        table_name: 'bridge_liquidation_addresses',
        record_id: bridgeLaDbId,
        affected_fields: Object.keys(updatePayload),
        previous_values: previous ?? undefined,
        new_values: updatePayload,
        reason,
        source: 'admin_panel',
      });
    }

    return result;
  }

  // ═══════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════

  /**
   * Convierte código de país ISO 3166-1 alpha-2 → alpha-3.
   * Bridge requiere alpha-3 en todos los campos "country" de direcciones.
   */
  private toAlpha3(code: string | undefined): string | undefined {
    if (!code) return undefined;
    if (code.length === 3) return code.toUpperCase(); // ya está en alpha-3
    const map: Record<string, string> = {
      US: 'USA',
      MX: 'MEX',
      BR: 'BRA',
      CO: 'COL',
      AR: 'ARG',
      CL: 'CHL',
      PE: 'PER',
      EC: 'ECU',
      BO: 'BOL',
      PY: 'PRY',
      UY: 'URY',
      VE: 'VEN',
      DE: 'DEU',
      FR: 'FRA',
      ES: 'ESP',
      IT: 'ITA',
      NL: 'NLD',
      GB: 'GBR',
      PT: 'PRT',
      BE: 'BEL',
      AT: 'AUT',
      CH: 'CHE',
      SE: 'SWE',
      NO: 'NOR',
      DK: 'DNK',
      FI: 'FIN',
      PL: 'POL',
      IE: 'IRL',
      CZ: 'CZE',
      HU: 'HUN',
      RO: 'ROU',
      SK: 'SVK',
      HR: 'HRV',
      BG: 'BGR',
      LT: 'LTU',
      LV: 'LVA',
      EE: 'EST',
      SI: 'SVN',
      LU: 'LUX',
      MT: 'MLT',
      CY: 'CYP',
      GR: 'GRC',
      CN: 'CHN',
      JP: 'JPN',
      KR: 'KOR',
      IN: 'IND',
      SG: 'SGP',
      AU: 'AUS',
      NZ: 'NZL',
      CA: 'CAN',
      ZA: 'ZAF',
      NG: 'NGA',
      KE: 'KEN',
      GH: 'GHA',
      // SEPA / zona IBAN — países que faltaban
      IS: 'ISL',
      LI: 'LIE',
      MC: 'MCO',
      SM: 'SMR',
      AD: 'AND',
    };
    return map[code.toUpperCase()] ?? code.toUpperCase();
  }

  private async getVerifiedProfile(userId: string) {
    const { data: profile, error } = await this.supabase
      .from('profiles')
      .select('bridge_customer_id, onboarding_status, is_frozen, is_active')
      .eq('id', userId)
      .single();

    if (error || !profile) throw new NotFoundException('Perfil no encontrado');
    if (!profile.is_active) throw new ForbiddenException('Cuenta inactiva');
    if (profile.is_frozen) throw new ForbiddenException('Cuenta congelada');
    if (
      profile.onboarding_status !== 'approved' ||
      !profile.bridge_customer_id
    ) {
      throw new BadRequestException(
        'Onboarding incompleto. Completa la verificación KYC/KYB primero.',
      );
    }

    return profile;
  }

  private async releaseReservedBalance(
    userId: string,
    currency: string,
    amount: number,
  ) {
    // Intentar via RPC primero, fallback a update manual
    const { error } = await this.supabase.rpc('release_reserved_balance', {
      p_user_id: userId,
      p_currency: currency.toUpperCase(),
      p_amount: amount,
    });

    if (error) {
      this.logger.warn(
        `RPC release_reserved_balance falló: ${error.message}. Usando fallback manual.`,
      );
      // Fallback: actualización directa
      const { data: balance } = await this.supabase
        .from('balances')
        .select('reserved_amount, available_amount')
        .eq('user_id', userId)
        .eq('currency', currency.toUpperCase())
        .single();

      if (balance) {
        await this.supabase
          .from('balances')
          .update({
            reserved_amount: Math.max(
              0,
              parseFloat(balance.reserved_amount) - amount,
            ),
            available_amount: parseFloat(balance.available_amount) + amount,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId)
          .eq('currency', currency.toUpperCase());
      }
    }
  }

  private async verifyTransactionLimits(userId: string, amount: number) {
    const { data: limits } = await this.supabase
      .from('transaction_limits')
      .select('single_txn_limit')
      .eq('user_id', userId)
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (limits?.single_txn_limit) {
      const limit = parseFloat(limits.single_txn_limit);
      if (amount > limit) {
        throw new BadRequestException(
          `El monto excede tu límite por transacción: $${limit}`,
        );
      }
    }
  }

  private async getPayoutReviewThreshold(): Promise<number> {
    const { data } = await this.supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'PAYOUT_REVIEW_THRESHOLD')
      .single();

    return parseFloat(data?.value ?? '10000');
  }

  /**
   * Lee los límites de creación de VAs desde `app_settings`.
   * Fallback a valores por defecto si no existen en la DB.
   *
   * Keys en app_settings:
   * - VA_MAX_TOTAL_ACTIVE_PER_USER: máx. VAs activas totales por usuario
   * - VA_MAX_EXTERNAL_PER_CURRENCY: máx. VAs externas por moneda por usuario
   */
  private async getVaCreationLimits(): Promise<{
    maxTotal: number;
    maxExternalPerCurrency: number;
  }> {
    const { data } = await this.supabase
      .from('app_settings')
      .select('key, value')
      .in('key', [
        'VA_MAX_TOTAL_ACTIVE_PER_USER',
        'VA_MAX_EXTERNAL_PER_CURRENCY',
      ]);

    const settings = Object.fromEntries(
      (data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]),
    );

    return {
      maxTotal: parseInt(settings['VA_MAX_TOTAL_ACTIVE_PER_USER'] ?? '24', 10),
      maxExternalPerCurrency: parseInt(
        settings['VA_MAX_EXTERNAL_PER_CURRENCY'] ?? '3',
        10,
      ),
    };
  }

  private async createComplianceReview(
    entityType: string,
    entityId: string,
    userId: string,
  ) {
    await this.supabase.from('compliance_reviews').insert({
      entity_type: entityType,
      entity_id: entityId,
      status: 'pending',
      requested_by: userId,
    });
  }

  /**
   * Mapea el payment_rail interno de Guira al `account_type` que Bridge espera.
   *
   * Bridge account_type values: us, iban, clabe, pix, bre_b, gb, unknown
   * Guira payment_rail values:  ach, wire, sepa, spei, pix, bre_b
   */
  private getBridgeAccountType(paymentRail: string): string {
    const accountType = PAYMENT_RAIL_TO_BRIDGE_ACCOUNT_TYPE[paymentRail];
    if (!accountType) {
      const supported = Object.keys(PAYMENT_RAIL_TO_BRIDGE_ACCOUNT_TYPE).join(
        ', ',
      );
      throw new BadRequestException(
        `Payment rail '${paymentRail}' no tiene un account_type de Bridge mapeado. Rails soportados: ${supported}`,
      );
    }
    return accountType;
  }

  // ═══════════════════════════════════════════════════
  //  ADMIN: VA FEE — RESOLUCIÓN INTERNA
  // ═══════════════════════════════════════════════════

  /**
   * Resuelve el developer_fee_percent para una combinación de usuario + moneda + destino.
   * 2 niveles: Override por usuario (va_fee_overrides) → Fee global (va_fee_defaults).
   */
  private async resolveVaFee(
    userId: string,
    sourceCurrency: string,
    destinationType: string,
  ): Promise<number | null> {
    // Nivel 1: Override por usuario
    const { data: override } = await this.supabase
      .from('va_fee_overrides')
      .select('fee_percent')
      .eq('user_id', userId)
      .eq('source_currency', sourceCurrency)
      .eq('destination_type', destinationType)
      .maybeSingle();

    if (override?.fee_percent != null) {
      return override.fee_percent;
    }

    // Nivel 2: Fee global por defecto
    const { data: defaultFee } = await this.supabase
      .from('va_fee_defaults')
      .select('fee_percent')
      .eq('source_currency', sourceCurrency)
      .eq('destination_type', destinationType)
      .maybeSingle();

    return defaultFee?.fee_percent ?? null;
  }

  // ═══════════════════════════════════════════════════
  //  ADMIN: VA FEE DEFAULTS (globales)
  // ═══════════════════════════════════════════════════

  /**
   * Lista todos los fees globales por defecto (6 monedas × 2 destinos = 12 registros).
   */
  async listVaFeeDefaults() {
    const { data, error } = await this.supabase
      .from('va_fee_defaults')
      .select('*')
      .order('source_currency')
      .order('destination_type');
    if (error) throwDbError(error);
    return data ?? [];
  }

  /**
   * Actualiza un fee global por defecto.
   */
  async updateVaFeeDefault(
    sourceCurrency: string,
    destinationType: string,
    feePercent: number,
    actorId: string,
  ) {
    const currency = sourceCurrency.toLowerCase();
    const destType = destinationType.toLowerCase();

    // Obtener valor anterior
    const { data: existing } = await this.supabase
      .from('va_fee_defaults')
      .select('id, fee_percent')
      .eq('source_currency', currency)
      .eq('destination_type', destType)
      .single();

    if (!existing) {
      throw new NotFoundException(
        `No se encontró configuración por defecto para ${currency.toUpperCase()} / ${destType}`,
      );
    }

    const oldFee = existing.fee_percent;

    const { data, error } = await this.supabase
      .from('va_fee_defaults')
      .update({
        fee_percent: feePercent,
        updated_by: actorId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throwDbError(error);

    // Audit log
    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      action: 'update_va_fee_default',
      table_name: 'va_fee_defaults',
      record_id: existing.id,
      affected_fields: ['fee_percent'],
      previous_values: {
        source_currency: currency,
        destination_type: destType,
        fee_percent: oldFee,
      },
      new_values: {
        source_currency: currency,
        destination_type: destType,
        fee_percent: feePercent,
      },
      reason: `Fee default actualizado: ${currency}/${destType} (${oldFee}% → ${feePercent}%)`,
      source: 'admin_panel',
    });

    this.logger.log(
      `VA fee default updated: ${currency}/${destType} (${oldFee}% → ${feePercent}%) by ${actorId}`,
    );
    return data;
  }

  // ═══════════════════════════════════════════════════
  //  ADMIN: VA FEE OVERRIDES (por usuario)
  // ═══════════════════════════════════════════════════

  /**
   * Lista todos los overrides de fee configurados para un usuario.
   */
  async listVaFeeOverrides(userId: string) {
    const { data, error } = await this.supabase
      .from('va_fee_overrides')
      .select('*')
      .eq('user_id', userId)
      .order('source_currency')
      .order('destination_type');
    if (error) throwDbError(error);
    return data ?? [];
  }

  /**
   * Establece o actualiza un override de fee por usuario (UPSERT).
   */
  async setVaFeeOverride(
    userId: string,
    body: {
      source_currency: string;
      destination_type: string;
      fee_percent: number;
      reason: string;
    },
    actorId: string,
  ) {
    const currency = body.source_currency.toLowerCase();
    const destType = body.destination_type.toLowerCase();

    // Verificar que el usuario existe
    const { data: profile } = await this.supabase
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .single();
    if (!profile) throw new NotFoundException('Usuario no encontrado');

    // Obtener valor anterior (si existe)
    const { data: existing } = await this.supabase
      .from('va_fee_overrides')
      .select('fee_percent')
      .eq('user_id', userId)
      .eq('source_currency', currency)
      .eq('destination_type', destType)
      .maybeSingle();

    const oldFee = existing?.fee_percent ?? null;

    // UPSERT
    const { data, error } = await this.supabase
      .from('va_fee_overrides')
      .upsert(
        {
          user_id: userId,
          source_currency: currency,
          destination_type: destType,
          fee_percent: body.fee_percent,
          reason: body.reason,
          set_by: actorId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,source_currency,destination_type' },
      )
      .select()
      .single();
    if (error) throwDbError(error);

    // Audit log
    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      action: 'set_va_fee_override',
      table_name: 'va_fee_overrides',
      record_id: userId,
      affected_fields: ['fee_percent'],
      previous_values: {
        source_currency: currency,
        destination_type: destType,
        fee_percent: oldFee,
      },
      new_values: {
        source_currency: currency,
        destination_type: destType,
        fee_percent: body.fee_percent,
      },
      reason: body.reason,
      source: 'admin_panel',
    });

    this.logger.log(
      `VA fee override set: user=${userId} ${currency}/${destType} fee=${body.fee_percent}% by ${actorId}`,
    );
    return data;
  }

  /**
   * Elimina un override de fee (el usuario vuelve a usar el fee global por defecto).
   */
  async clearVaFeeOverride(
    userId: string,
    sourceCurrency: string,
    destinationType: string,
    actorId: string,
  ) {
    const currency = sourceCurrency.toLowerCase();
    const destType = destinationType.toLowerCase();

    const { data: existing } = await this.supabase
      .from('va_fee_overrides')
      .select('fee_percent')
      .eq('user_id', userId)
      .eq('source_currency', currency)
      .eq('destination_type', destType)
      .maybeSingle();

    if (!existing) {
      throw new NotFoundException(
        `No hay override configurado para ${currency.toUpperCase()} / ${destType}`,
      );
    }

    const { error } = await this.supabase
      .from('va_fee_overrides')
      .delete()
      .eq('user_id', userId)
      .eq('source_currency', currency)
      .eq('destination_type', destType);
    if (error) throwDbError(error);

    // Audit log
    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      action: 'clear_va_fee_override',
      table_name: 'va_fee_overrides',
      record_id: userId,
      affected_fields: ['fee_percent'],
      previous_values: {
        source_currency: currency,
        destination_type: destType,
        fee_percent: existing.fee_percent,
      },
      new_values: null,
      reason: `Override eliminado para ${currency.toUpperCase()} / ${destType}`,
      source: 'admin_panel',
    });

    this.logger.log(
      `VA fee override cleared: user=${userId} ${currency}/${destType} by ${actorId}`,
    );
    return {
      deleted: true,
      source_currency: currency,
      destination_type: destType,
    };
  }

  /**
   * Devuelve la matriz completa de fees resueltos (12 combinaciones)
   * para un usuario, indicando la fuente (override o default).
   */
  async getResolvedVaFeeMatrix(userId: string) {
    const currencies = ['usd', 'eur', 'mxn', 'brl', 'gbp', 'cop'];
    const destTypes = ['wallet_bridge', 'wallet_external'];

    // Obtener todos los overrides del usuario
    const { data: overrides } = await this.supabase
      .from('va_fee_overrides')
      .select('source_currency, destination_type, fee_percent')
      .eq('user_id', userId);

    // Obtener todos los defaults
    const { data: defaults } = await this.supabase
      .from('va_fee_defaults')
      .select('source_currency, destination_type, fee_percent');

    const overrideMap = new Map(
      (overrides ?? []).map((o) => [
        `${o.source_currency}:${o.destination_type}`,
        o.fee_percent,
      ]),
    );
    const defaultMap = new Map(
      (defaults ?? []).map((d) => [
        `${d.source_currency}:${d.destination_type}`,
        d.fee_percent,
      ]),
    );

    const matrix: Array<{
      source_currency: string;
      destination_type: string;
      resolved_fee: number | null;
      source: 'override' | 'default';
    }> = [];

    for (const currency of currencies) {
      for (const destType of destTypes) {
        const key = `${currency}:${destType}`;
        const overrideFee = overrideMap.get(key);
        if (overrideFee != null) {
          matrix.push({
            source_currency: currency,
            destination_type: destType,
            resolved_fee: overrideFee,
            source: 'override',
          });
        } else {
          matrix.push({
            source_currency: currency,
            destination_type: destType,
            resolved_fee: defaultMap.get(key) ?? null,
            source: 'default',
          });
        }
      }
    }

    return matrix;
  }

  /**
   * Lista las VAs activas de un usuario (para admin).
   */
  async listUserVirtualAccounts(userId: string) {
    const { data, error } = await this.supabase
      .from('bridge_virtual_accounts')
      .select(
        'id, bridge_virtual_account_id, source_currency, destination_currency, destination_address, destination_payment_rail, developer_fee_percent, is_external_sweep, status, created_at',
      )
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('created_at', { ascending: false });
    if (error) throwDbError(error);
    return data ?? [];
  }

  // ═══════════════════════════════════════════════════
  //  ADMIN: VA UPDATE (fee, destination, currency)
  // ═══════════════════════════════════════════════════

  /**
   * Actualiza campos de una VA existente en Bridge y en DB local.
   * Soporta: developer_fee_percent, destination.address, destination.currency.
   * Solo admin/super_admin.
   */
  async updateVirtualAccount(
    vaId: string,
    dto: UpdateVirtualAccountDto,
    actorId: string,
  ) {
    // 1. Obtener VA completa
    const { data: va, error } = await this.supabase
      .from('bridge_virtual_accounts')
      .select('*')
      .eq('id', vaId)
      .single();
    if (error || !va)
      throw new NotFoundException('Virtual Account no encontrada');
    if (va.status !== 'active')
      throw new BadRequestException('Solo se pueden actualizar VAs activas');

    // 2. Construir payload para Bridge API (solo campos presentes)
    const bridgePayload: Record<string, unknown> = {};
    const dbUpdate: Record<string, unknown> = {};
    const previousValues: Record<string, unknown> = {};
    const affectedFields: string[] = [];

    if (dto.developer_fee_percent !== undefined) {
      bridgePayload.developer_fee_percent =
        dto.developer_fee_percent.toString();
      dbUpdate.developer_fee_percent = dto.developer_fee_percent;
      previousValues.developer_fee_percent = va.developer_fee_percent;
      affectedFields.push('developer_fee_percent');
    }
    if (
      dto.destination_address !== undefined ||
      dto.destination_currency !== undefined ||
      dto.destination_payment_rail !== undefined
    ) {
      bridgePayload.destination = {
        ...((bridgePayload.destination ?? {}) as object),
        address: dto.destination_address ?? va.destination_address,
        currency: (
          dto.destination_currency ?? va.destination_currency
        ).toLowerCase(),
        payment_rail: (
          dto.destination_payment_rail ?? va.destination_payment_rail
        ).toLowerCase(),
      };

      if (dto.destination_address !== undefined) {
        dbUpdate.destination_address = dto.destination_address;
        previousValues.destination_address = va.destination_address;
        affectedFields.push('destination_address');

        // Si se cambia la dirección, actualizar is_external_sweep
        if (dto.destination_address && !va.is_external_sweep) {
          dbUpdate.is_external_sweep = true;
          previousValues.is_external_sweep = va.is_external_sweep;
          affectedFields.push('is_external_sweep');
        }
      }

      if (dto.destination_currency !== undefined) {
        dbUpdate.destination_currency = dto.destination_currency.toLowerCase();
        previousValues.destination_currency = va.destination_currency;
        affectedFields.push('destination_currency');
      }

      if (dto.destination_payment_rail !== undefined) {
        dbUpdate.destination_payment_rail =
          dto.destination_payment_rail.toLowerCase();
        previousValues.destination_payment_rail = va.destination_payment_rail;
        affectedFields.push('destination_payment_rail');
      }
    }

    if (Object.keys(bridgePayload).length === 0) {
      throw new BadRequestException(
        'Debe especificar al menos un campo a actualizar (developer_fee_percent, destination_address, destination_currency o destination_payment_rail)',
      );
    }

    // 3. PUT a Bridge
    await this.bridgeApi.put(
      `/v0/customers/${va.bridge_customer_id}/virtual_accounts/${va.bridge_virtual_account_id}`,
      bridgePayload,
    );

    // 4. UPDATE en DB local (con compensación si falla)
    let updated: Record<string, unknown>;
    try {
      const { data: updatedRow, error: dbErr } = await this.supabase
        .from('bridge_virtual_accounts')
        .update(dbUpdate)
        .eq('id', vaId)
        .select()
        .single();
      if (dbErr) throw new Error(dbErr.message);
      updated = updatedRow;
    } catch (dbError) {
      // Compensación: intentar revertir en Bridge
      this.logger.error(
        `DB update falló tras PUT exitoso a Bridge. Intentando revertir… ${dbError}`,
      );
      const revertPayload: Record<string, unknown> = {};
      if (dto.developer_fee_percent !== undefined) {
        revertPayload.developer_fee_percent =
          va.developer_fee_percent?.toString() ?? '0';
      }
      if (
        dto.destination_address !== undefined ||
        dto.destination_currency !== undefined ||
        dto.destination_payment_rail !== undefined
      ) {
        revertPayload.destination = {};
        if (dto.destination_address !== undefined) {
          (revertPayload.destination as Record<string, string>).address =
            va.destination_address ?? '';
        }
        if (dto.destination_currency !== undefined) {
          (revertPayload.destination as Record<string, string>).currency =
            va.destination_currency;
        }
        if (dto.destination_payment_rail !== undefined) {
          (revertPayload.destination as Record<string, string>).payment_rail =
            va.destination_payment_rail;
        }
      }
      try {
        await this.bridgeApi.put(
          `/v0/customers/${va.bridge_customer_id}/virtual_accounts/${va.bridge_virtual_account_id}`,
          revertPayload,
        );
        this.logger.warn('Reversión en Bridge exitosa');
      } catch (revertErr) {
        this.logger.error(
          `CRÍTICO: Reversión en Bridge también falló: ${revertErr}`,
        );
      }
      throw new BadRequestException(
        'Error al actualizar VA en DB local. Se intentó revertir en Bridge.',
      );
    }

    // 5. Audit log
    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      action: 'update_virtual_account',
      table_name: 'bridge_virtual_accounts',
      record_id: vaId,
      affected_fields: affectedFields,
      previous_values: previousValues,
      new_values: dbUpdate,
      reason: dto.reason,
      source: 'admin_panel',
    });

    this.logger.log(
      `VA updated: ${vaId} fields=[${affectedFields.join(', ')}] by ${actorId}`,
    );
    return updated;
  }
}
