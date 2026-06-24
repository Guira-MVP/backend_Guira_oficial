import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { throwDbError } from '../../core/utils/db-error.util';
import { AdminGateway } from '../admin/admin.gateway';

@Injectable()
export class FeesService {
  private readonly logger = new Logger(FeesService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly adminGateway: AdminGateway,
  ) {}

  // ───────────────────────────────────────────────
  //  Endpoints públicos
  // ───────────────────────────────────────────────

  /** Lista tarifas vigentes (solo activas + públicas). */
  async getPublicFees() {
    const { data, error } = await this.supabase
      .from('fees_config')
      .select(
        'operation_type, payment_rail, currency, fee_type, fee_percent, fee_fixed, min_fee, max_fee, description',
      )
      .eq('is_active', true)
      .order('operation_type');

    if (error) throwDbError(error);
    return data ?? [];
  }

  // ───────────────────────────────────────────────
  //  Admin — CRUD de tarifas
  // ───────────────────────────────────────────────

  /** Lista todas las tarifas (activas e inactivas). */
  async getAllFees() {
    const { data, error } = await this.supabase
      .from('fees_config')
      .select('*')
      .order('operation_type');

    if (error) throwDbError(error);
    return data ?? [];
  }

  /** Crea una nueva tarifa. */
  async createFee(dto: {
    operation_type: string;
    payment_rail: string;
    currency: string;
    fee_type: string;
    fee_percent?: number;
    fee_fixed?: number;
    min_fee?: number;
    max_fee?: number;
    description?: string;
  }) {
    const { data, error } = await this.supabase
      .from('fees_config')
      .insert({
        ...dto,
        is_active: true,
      })
      .select()
      .single();

    if (error) throwDbError(error);

    // WS: notificar al staff que se creó una nueva tarifa
    this.adminGateway.emitFeeConfigUpdated({
      id: data.id,
      operation_type: data.operation_type ?? null,
      payment_rail: data.payment_rail ?? null,
      currency: data.currency ?? null,
      fee_type: data.fee_type ?? null,
      fee_percent: data.fee_percent ?? null,
      fee_fixed: data.fee_fixed ?? null,
      min_fee: data.min_fee ?? null,
      max_fee: data.max_fee ?? null,
      is_active: data.is_active ?? true,
      updated_at: data.updated_at ?? new Date().toISOString(),
      action: 'created',
    });

    return data;
  }

  /** Actualiza una tarifa existente. */
  async updateFee(
    feeId: string,
    dto: {
      fee_type?: string;
      fee_percent?: number;
      fee_fixed?: number;
      min_fee?: number;
      max_fee?: number;
      is_active?: boolean;
      description?: string;
    },
  ) {
    const { data, error } = await this.supabase
      .from('fees_config')
      .update({ ...dto, updated_at: new Date().toISOString() })
      .eq('id', feeId)
      .select()
      .single();

    if (error || !data) throw new NotFoundException('Tarifa no encontrada');

    // WS: notificar al staff que se actualizó una tarifa
    this.adminGateway.emitFeeConfigUpdated({
      id: data.id,
      operation_type: data.operation_type ?? null,
      payment_rail: data.payment_rail ?? null,
      currency: data.currency ?? null,
      fee_type: data.fee_type ?? null,
      fee_percent: data.fee_percent ?? null,
      fee_fixed: data.fee_fixed ?? null,
      min_fee: data.min_fee ?? null,
      max_fee: data.max_fee ?? null,
      is_active: data.is_active ?? true,
      updated_at: data.updated_at ?? new Date().toISOString(),
      action: 'updated',
    });

    return data;
  }

  // ───────────────────────────────────────────────
  //  Overrides por cliente
  // ───────────────────────────────────────────────

  /** Obtiene overrides de fee para un usuario. */
  async getOverrides(userId: string) {
    const { data, error } = await this.supabase
      .from('customer_fee_overrides')
      .select('*')
      .eq('user_id', userId)
      .order('operation_type');

    if (error) throwDbError(error);
    return data ?? [];
  }

  /** Crea un override de fee para un cliente VIP. */
  async createOverride(
    dto: {
      user_id: string;
      operation_type: string;
      payment_rail: string;
      currency: string;
      fee_type: string;
      fee_percent?: number;
      fee_fixed?: number;
      min_fee?: number;
      max_fee?: number;
      valid_from?: string;
      valid_until?: string;
      notes?: string;
    },
    actorId: string,
    actorRole: string,
  ) {
    // Validar que no exista un override activo duplicado para la misma
    // combinación user + operation + rail + currency
    const { data: conflict } = await this.supabase
      .from('customer_fee_overrides')
      .select('id')
      .eq('user_id', dto.user_id)
      .eq('operation_type', dto.operation_type)
      .eq('payment_rail', dto.payment_rail)
      .eq('currency', dto.currency.toLowerCase())
      .eq('is_active', true)
      .maybeSingle();

    if (conflict) {
      throw new BadRequestException(
        `Ya existe un override activo para ${dto.operation_type}/${dto.payment_rail}/${dto.currency}. Desactívalo o elimínalo primero.`,
      );
    }

    // D4 Fix: Asegurar que valid_from siempre tenga un valor
    const today = new Date().toISOString().split('T')[0];

    // D6 Fix: Normalizar currency a minúsculas para consistencia con fees_config
    const normalizedCurrency = dto.currency?.toLowerCase();

    const { data, error } = await this.supabase
      .from('customer_fee_overrides')
      .insert({
        ...dto,
        currency: normalizedCurrency,
        valid_from: dto.valid_from ?? today,
        is_active: true,
        created_by: actorId,
      })
      .select()
      .single();

    if (error) throwDbError(error);

    // Audit log
    await this.supabase.from('audit_logs').insert({
      performed_by:    actorId,
      role:            actorRole,
      action:          'FEE_OVERRIDE_CREATED',
      table_name:      'customer_fee_overrides',
      record_id:       data.id,
      reason:          `Override creado para ${dto.operation_type}/${dto.payment_rail ?? 'any'}`,
      new_values: {
        user_id:        dto.user_id,
        operation_type: dto.operation_type,
        payment_rail:   dto.payment_rail,
        fee_type:       dto.fee_type,
        valid_from:     dto.valid_from ?? today,
      },
      source: 'admin_panel',
    });

    return data;
  }

  /** Actualiza un override existente. */
  async updateOverride(
    overrideId: string,
    dto: {
      fee_percent?: number;
      fee_fixed?: number;
      min_fee?: number;
      max_fee?: number;
      is_active?: boolean;
      valid_until?: string;
      notes?: string;
    },
    actorId: string,
    actorRole: string,
  ) {
    // 1. Obtener override actual para auditoría
    const { data: current, error: findError } = await this.supabase
      .from('customer_fee_overrides')
      .select('*')
      .eq('id', overrideId)
      .single();

    if (findError || !current)
      throw new NotFoundException('Override no encontrado');

    // 2. Si se está activando, verificar que no haya otro activo
    //    para la misma combinación user + operation + rail + currency
    if (dto.is_active === true && !current.is_active) {
      const { data: conflict } = await this.supabase
        .from('customer_fee_overrides')
        .select('id')
        .eq('user_id', current.user_id)
        .eq('operation_type', current.operation_type)
        .eq('payment_rail', current.payment_rail)
        .eq('currency', current.currency)
        .eq('is_active', true)
        .neq('id', overrideId)
        .maybeSingle();

      if (conflict) {
        throw new BadRequestException(
          `Ya existe un override activo para ${current.operation_type}/${current.payment_rail}/${current.currency}. Desactívalo primero.`,
        );
      }
    }

    // 3. Actualizar
    const { data, error } = await this.supabase
      .from('customer_fee_overrides')
      .update({ ...dto, updated_at: new Date().toISOString() })
      .eq('id', overrideId)
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException('No se pudo actualizar el override');

    // 4. Audit log
    await this.supabase.from('audit_logs').insert({
      performed_by:    actorId,
      role:            actorRole,
      action:          'FEE_OVERRIDE_UPDATED',
      table_name:      'customer_fee_overrides',
      record_id:       overrideId,
      reason:          `Override actualizado para usuario ${current.user_id}`,
      previous_values: {
        fee_percent: current.fee_percent,
        fee_fixed:   current.fee_fixed,
        is_active:   current.is_active,
      },
      new_values: dto,
      source: 'admin_panel',
    });

    return data;
  }

  /** Elimina permanentemente un override. */
  async deleteOverride(overrideId: string, actorId: string, actorRole: string) {
    // 1. Obtener override para auditoría
    const { data: current, error: findError } = await this.supabase
      .from('customer_fee_overrides')
      .select('*')
      .eq('id', overrideId)
      .single();

    if (findError || !current)
      throw new NotFoundException('Override no encontrado');

    // 2. Eliminar
    const { error } = await this.supabase
      .from('customer_fee_overrides')
      .delete()
      .eq('id', overrideId);

    if (error) throw new BadRequestException('No se pudo eliminar el override');

    // 3. Audit log
    await this.supabase.from('audit_logs').insert({
      performed_by:    actorId,
      role:            actorRole,
      action:          'FEE_OVERRIDE_DELETED',
      table_name:      'customer_fee_overrides',
      record_id:       overrideId,
      reason:          `Override ${current.operation_type}/${current.payment_rail ?? 'any'} eliminado permanentemente`,
      previous_values: {
        user_id:        current.user_id,
        operation_type: current.operation_type,
        payment_rail:   current.payment_rail,
        fee_type:       current.fee_type,
      },
      source: 'admin_panel',
    });

    return { message: 'Override eliminado permanentemente' };
  }

  // ───────────────────────────────────────────────
  //  Preview de fee — para estimación en UI
  // ───────────────────────────────────────────────

  /**
   * Calcula el fee que se aplicaría a un usuario para una operación dada,
   * sin crear ningún registro. Devuelve también si proviene de un override personal.
   */
  async previewFee(
    userId: string,
    operationType: string,
    paymentRail: string,
    currency: string,
    amount: number,
  ): Promise<{
    fee_amount: number;
    net_amount: number;
    fee_type: string;
    fee_percent: number;
    fee_fixed: number;
    min_fee: number;
    max_fee: number;
    is_override: boolean;
  }> {
    const today = new Date().toISOString().split('T')[0];
    const normalizedCurrency = currency.toLowerCase();

    const { data: override } = await this.supabase
      .from('customer_fee_overrides')
      .select('*')
      .eq('user_id', userId)
      .eq('operation_type', operationType)
      .eq('payment_rail', paymentRail)
      .eq('currency', normalizedCurrency)
      .eq('is_active', true)
      .or(`valid_from.is.null,valid_from.lte.${today}`)
      .or(`valid_until.is.null,valid_until.gte.${today}`)
      .maybeSingle();

    let feeConfig = override;
    let isOverride = !!override;

    if (!feeConfig) {
      const { data: globalFee } = await this.supabase
        .from('fees_config')
        .select('*')
        .eq('operation_type', operationType)
        .eq('payment_rail', paymentRail)
        .eq('currency', normalizedCurrency)
        .eq('is_active', true)
        .maybeSingle();

      feeConfig = globalFee;
      isOverride = false;
    }

    if (!feeConfig) {
      return {
        fee_amount: 0,
        net_amount: amount,
        fee_type: 'percent',
        fee_percent: 0,
        fee_fixed: 0,
        min_fee: 0,
        max_fee: 0,
        is_override: false,
      };
    }

    const amountCents = Math.round(amount * 100);
    const feePercent = parseFloat(feeConfig.fee_percent ?? '0');
    const feeFixedCents = Math.round(parseFloat(feeConfig.fee_fixed ?? '0') * 100);

    let feeCents = 0;
    if (feeConfig.fee_type === 'percent') {
      feeCents = Math.round((amountCents * feePercent) / 100);
    } else if (feeConfig.fee_type === 'fixed') {
      feeCents = feeFixedCents;
    } else if (feeConfig.fee_type === 'mixed') {
      feeCents = feeFixedCents + Math.round((amountCents * feePercent) / 100);
    }

    const minFeeCents = Math.round(parseFloat(feeConfig.min_fee ?? '0') * 100);
    const maxFeeCents = Math.round(parseFloat(feeConfig.max_fee ?? '0') * 100);
    if (minFeeCents > 0) feeCents = Math.max(feeCents, minFeeCents);
    if (maxFeeCents > 0) feeCents = Math.min(feeCents, maxFeeCents);

    return {
      fee_amount: feeCents / 100,
      net_amount: (amountCents - feeCents) / 100,
      fee_type: feeConfig.fee_type ?? 'percent',
      fee_percent: parseFloat(feeConfig.fee_percent ?? '0'),
      fee_fixed: parseFloat(feeConfig.fee_fixed ?? '0'),
      min_fee: parseFloat(feeConfig.min_fee ?? '0'),
      max_fee: parseFloat(feeConfig.max_fee ?? '0'),
      is_override: isOverride,
    };
  }

  // ───────────────────────────────────────────────
  //  Servicio  interno — Cálculo de fee
  // ───────────────────────────────────────────────

  /**
   * Retorna el fee_percent configurado para una operación (override del cliente → global).
   * Siempre devuelve string decimal (ej: "1.0", "0.5").
   */
  async getFeePercent(
    userId: string,
    operationType: string,
    paymentRail: string,
    currency: string,
  ): Promise<string> {
    const today = new Date().toISOString().split('T')[0];
    const normalizedCurrency = currency.toLowerCase();

    const { data: override } = await this.supabase
      .from('customer_fee_overrides')
      .select('fee_percent')
      .eq('user_id', userId)
      .eq('operation_type', operationType)
      .eq('payment_rail', paymentRail)
      .eq('currency', normalizedCurrency)
      .eq('is_active', true)
      .or(`valid_from.is.null,valid_from.lte.${today}`)
      .or(`valid_until.is.null,valid_until.gte.${today}`)
      .maybeSingle();

    if (override?.fee_percent != null) {
      return parseFloat(override.fee_percent).toString();
    }

    const { data: globalFee } = await this.supabase
      .from('fees_config')
      .select('fee_percent')
      .eq('operation_type', operationType)
      .eq('payment_rail', paymentRail)
      .eq('currency', normalizedCurrency)
      .eq('is_active', true)
      .maybeSingle();

    return parseFloat(globalFee?.fee_percent ?? '0').toString();
  }

  /**
   * Calcula el fee para una operación, considerando overrides del cliente.
   * Retorna fee_amount y net_amount.
   */
  async calculateFee(
    userId: string,
    operationType: string,
    paymentRail: string,
    currency: string,
    amount: number,
  ): Promise<{ fee_amount: number; net_amount: number }> {
    const today = new Date().toISOString().split('T')[0];
    const normalizedCurrency = currency.toLowerCase();

    // 1. Buscar override del cliente para esta divisa específica
    const { data: override } = await this.supabase
      .from('customer_fee_overrides')
      .select('*')
      .eq('user_id', userId)
      .eq('operation_type', operationType)
      .eq('payment_rail', paymentRail)
      .eq('currency', normalizedCurrency)
      .eq('is_active', true)
      .or(`valid_from.is.null,valid_from.lte.${today}`)
      .or(`valid_until.is.null,valid_until.gte.${today}`)
      .maybeSingle();

    // 2. Si no hay override, usar tarifa global para esta divisa
    let feeConfig = override;
    if (!feeConfig) {
      const { data: globalFee } = await this.supabase
        .from('fees_config')
        .select('*')
        .eq('operation_type', operationType)
        .eq('payment_rail', paymentRail)
        .eq('currency', normalizedCurrency)
        .eq('is_active', true)
        .maybeSingle();

      feeConfig = globalFee;
    }

    if (!feeConfig) {
      // No hay tarifa configurada — sin fee
      return { fee_amount: 0, net_amount: amount };
    }

    // 3. Calcular en centavos enteros para evitar errores de punto flotante
    const amountCents = Math.round(amount * 100);
    const feePercent = parseFloat(feeConfig.fee_percent ?? '0');
    const feeFixedCents = Math.round(
      parseFloat(feeConfig.fee_fixed ?? '0') * 100,
    );

    let feeCents = 0;
    if (feeConfig.fee_type === 'percent') {
      feeCents = Math.round((amountCents * feePercent) / 100);
    } else if (feeConfig.fee_type === 'fixed') {
      feeCents = feeFixedCents;
    } else if (feeConfig.fee_type === 'mixed') {
      feeCents = feeFixedCents + Math.round((amountCents * feePercent) / 100);
    }

    // 4. Aplicar min/max en centavos
    const minFeeCents = Math.round(parseFloat(feeConfig.min_fee ?? '0') * 100);
    const maxFeeCents = Math.round(parseFloat(feeConfig.max_fee ?? '0') * 100);
    if (minFeeCents > 0) feeCents = Math.max(feeCents, minFeeCents);
    if (maxFeeCents > 0) feeCents = Math.min(feeCents, maxFeeCents);

    return {
      fee_amount: feeCents / 100,
      net_amount: (amountCents - feeCents) / 100,
    };
  }

  /** Elimina permanentemente una tarifa global. Solo super_admin. */
  async deleteFee(feeId: string, actorId: string, actorRole: string) {
    const { data: current, error: findError } = await this.supabase
      .from('fees_config')
      .select('*')
      .eq('id', feeId)
      .single();

    if (findError || !current)
      throw new NotFoundException('Tarifa no encontrada');

    const { error } = await this.supabase
      .from('fees_config')
      .delete()
      .eq('id', feeId);

    if (error) throw new BadRequestException('No se pudo eliminar la tarifa');

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role:         actorRole,
      action:       'FEE_CONFIG_DELETED',
      table_name:   'fees_config',
      record_id:    feeId,
      reason:       `Tarifa ${current.operation_type}/${current.payment_rail}/${current.currency} eliminada`,
      previous_values: {
        operation_type: current.operation_type,
        payment_rail:   current.payment_rail,
        currency:       current.currency,
        fee_type:       current.fee_type,
        fee_percent:    current.fee_percent,
      },
      source: 'admin_panel',
    });

    return { message: 'Tarifa eliminada permanentemente' };
  }
}
