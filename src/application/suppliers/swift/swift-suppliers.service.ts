import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../../core/supabase/supabase.module';
import { throwDbError } from '../../../core/utils/db-error.util';
import { NotificationsService } from '../../notifications/notifications.service';
import { NotificationType } from '../../notifications/dto/notifications.dto';
import { TazapaySwiftEligibilityService } from '../../tazapay/swift/tazapay-swift-eligibility.service';
import {
  BeneficiaryType,
  TazapayCorridorService,
} from '../../tazapay/swift/tazapay-corridor.service';
import { TazapayBeneficiariesService } from '../../tazapay/swift/tazapay-beneficiaries.service';
import {
  accountLast4,
  bankDetailsToSwiftValues,
  swiftValuesToBankDetails,
} from './swift-bank-details';
import type {
  CreateSupplierDto,
  UpdateSupplierDto,
} from '../dto/create-supplier.dto';

export const SWIFT_RAIL = 'swift';

/** Tras este tiempo un alta pendiente se da por fallida (la idempotencia de Tazapay dura 24 h). */
const PENDING_GIVE_UP_HOURS = 23;
/** Un alta recién creada puede estar todavía en curso: el worker no la toca antes. */
const PENDING_MIN_AGE_MS = 2 * 60_000;

/** Campos de Tazapay que se pueden editar después del alta (no bancarios). */
const EDITABLE_PREFIXES = ['address.', 'phone.'];
const EDITABLE_KEYS = new Set(['email']);

export interface SwiftStatusInfo {
  swift_status: 'pending' | 'active' | 'inactive' | 'failed';
  tazapay_beneficiary_id?: string | null;
  swift_last_error?: string | null;
}

/**
 * Proveedores SWIFT: viven en `suppliers` (payment_rail = 'swift') y en
 * Tazapay como beneficiarios, sin pasar nunca por Bridge.
 *
 * Orden del alta (al revés que con Bridge, a propósito): primero se insertan
 * las filas en Guira y después se llama a Tazapay con una idempotency key
 * fija por proveedor. Así un reintento no duplica el beneficiario y, si
 * Tazapay falla, no queda nada huérfano de su lado.
 */
@Injectable()
export class SwiftSuppliersService {
  private readonly logger = new Logger(SwiftSuppliersService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly eligibility: TazapaySwiftEligibilityService,
    private readonly corridors: TazapayCorridorService,
    private readonly beneficiaries: TazapayBeneficiariesService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Alta ──────────────────────────────────────────────────────────────

  async create(
    userId: string,
    dto: CreateSupplierDto,
    normalizedEmail: string | null,
  ) {
    await this.eligibility.assertEligible(userId);

    const name = dto.name.trim();
    if (name.length > 140) {
      throw new BadRequestException(
        'El nombre del beneficiario SWIFT admite como máximo 140 caracteres.',
      );
    }

    const country = String(dto.bank_country ?? '').toUpperCase();
    const currency = String(dto.currency ?? '').toUpperCase();
    const beneficiaryType = dto.beneficiary_type as BeneficiaryType;

    const schema = await this.corridors.getFormSchema(
      country,
      currency,
      beneficiaryType,
    );
    if (!schema.available) {
      throw new BadRequestException({
        code: schema.reason,
        message: schema.message,
      });
    }

    const { values, errors } = this.corridors.validateAgainstSchema(
      schema,
      dto.swift_fields ?? {},
    );
    if (errors.length > 0) {
      throw new BadRequestException({
        code: 'SWIFT_FIELDS_INVALID',
        message: errors[0].message,
        errors,
      });
    }

    if (normalizedEmail) {
      const { data: existing } = await this.supabase
        .from('suppliers')
        .select('id, name')
        .eq('user_id', userId)
        .eq('contact_email', normalizedEmail)
        .eq('payment_rail', SWIFT_RAIL)
        .eq('currency', currency.toLowerCase())
        .eq('is_active', true)
        .filter('bank_details->>bank_country', 'eq', country)
        .maybeSingle();
      if (existing) {
        throw new ConflictException(
          `El contacto "${normalizedEmail}" ya tiene una cuenta SWIFT en ${currency} con un banco de ${country} ` +
            `(proveedor: "${(existing as { name: string }).name}").`,
        );
      }
    }

    if (!this.beneficiaries.isConfigured) {
      throw new ServiceUnavailableException(
        'Las transferencias SWIFT no están disponibles en este momento.',
      );
    }

    const bankDetails = swiftValuesToBankDetails(values, {
      bank_country: country,
      beneficiary_type: beneficiaryType,
    });

    const { data: supplier, error } = await this.supabase
      .from('suppliers')
      .insert({
        user_id: userId,
        name,
        currency: currency.toLowerCase(),
        payment_rail: SWIFT_RAIL,
        bank_details: bankDetails,
        contact_email: normalizedEmail,
        notes: dto.notes ?? null,
        bridge_external_account_id: null,
        bridge_liquidation_address_id: null,
        is_active: true,
        is_verified: false,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException(
          'Proveedor duplicado: este contacto ya tiene una cuenta SWIFT activa en ese país y moneda.',
        );
      }
      throwDbError(error);
    }

    const payload = this.beneficiaries.buildPayload({
      userId,
      supplierId: supplier.id as string,
      name,
      beneficiaryType,
      country,
      currency,
      values,
    });

    const { data: row, error: rowError } = await this.supabase
      .from('tazapay_beneficiaries')
      .insert({
        user_id: userId,
        supplier_id: supplier.id,
        beneficiary_type: beneficiaryType,
        country,
        currency,
        swift_code: values['bank_codes.swift_code'],
        account_last_4: accountLast4(values),
        status: 'pending',
        idempotency_key: `guira-bnf-${supplier.id as string}`,
        request_payload: this.beneficiaries.redactPayload(payload),
      })
      .select('id, idempotency_key, attempt_count')
      .single();

    if (rowError || !row) {
      await this.supabase.from('suppliers').delete().eq('id', supplier.id);
      throwDbError(rowError ?? { message: 'tazapay_beneficiaries sin fila' });
    }

    const outcome = await this.submit(row, payload);

    if (outcome.status === 'rejected') {
      // Tazapay no creó nada: se borran las dos filas (cascade) para que el
      // cliente corrija y vuelva a intentar sin chocar con la unicidad.
      await this.supabase.from('suppliers').delete().eq('id', supplier.id);
      if (outcome.invalidateCorridor) await this.corridors.invalidate(country);
      await this.supabase.from('audit_logs').insert({
        performed_by: userId,
        role: 'client',
        action: 'SWIFT_BENEFICIARY_REJECTED',
        table_name: 'suppliers',
        record_id: null,
        new_values: { country, currency, code: outcome.code },
        reason: 'Tazapay rechazó el alta del beneficiario SWIFT',
        source: 'api',
      });
      throw new BadRequestException({
        code: 'SWIFT_PROVIDER_REJECTED',
        message: outcome.message,
        errors: outcome.field
          ? [{ field: outcome.field, message: outcome.message }]
          : [],
      });
    }

    await this.supabase.from('audit_logs').insert({
      performed_by: userId,
      role: 'client',
      action: 'CREATE_SUPPLIER',
      table_name: 'suppliers',
      record_id: supplier.id,
      new_values: {
        name,
        contact_email: normalizedEmail,
        payment_rail: SWIFT_RAIL,
        currency: currency.toLowerCase(),
        bank_country: country,
        swift_status: outcome.status,
      },
    });

    return {
      ...supplier,
      swift_status: outcome.status,
      beneficiary_address_valid: null,
      developer_fee_percent: null,
    };
  }

  /**
   * Llama a Tazapay y actualiza la fila de tazapay_beneficiaries.
   * - active:   Tazapay devolvió el bnf_.
   * - rejected: 4xx de validación; nada se creó en Tazapay.
   * - pending:  falla técnica; se reintenta con la misma key.
   */
  private async submit(
    row: { id: string; idempotency_key: string; attempt_count: number | null },
    payload: Record<string, unknown>,
  ): Promise<
    | { status: 'active' | 'pending' }
    | {
        status: 'rejected';
        message: string;
        field: string | null;
        code: string | null;
        invalidateCorridor: boolean;
      }
  > {
    const attempts = (row.attempt_count ?? 0) + 1;
    try {
      const created = await this.beneficiaries.create(
        payload,
        row.idempotency_key,
      );
      await this.supabase
        .from('tazapay_beneficiaries')
        .update({
          status: 'active',
          tazapay_beneficiary_id: created.id,
          destination_id: created.destination,
          raw_response: this.beneficiaries.redactResponse(created.raw),
          attempt_count: attempts,
          last_error_code: null,
          last_error_message: null,
        })
        .eq('id', row.id);
      return { status: 'active' };
    } catch (err) {
      const mapped = this.beneficiaries.mapError(err);
      await this.supabase
        .from('tazapay_beneficiaries')
        .update({
          attempt_count: attempts,
          last_error_code: mapped.code,
          last_error_message:
            `${mapped.message} [${(err as Error).message}]`.slice(0, 1000),
          ...(mapped.isValidation ? { status: 'failed' } : {}),
        })
        .eq('id', row.id);

      if (mapped.isValidation) {
        this.logger.warn(
          `Tazapay rechazó el beneficiario ${row.id} (${mapped.code ?? 's/código'}): ${mapped.message}`,
        );
        return {
          status: 'rejected',
          message: mapped.message,
          field: mapped.field,
          code: mapped.code,
          invalidateCorridor: mapped.invalidateCorridor,
        };
      }
      this.logger.warn(
        `Alta del beneficiario ${row.id} queda pendiente: ${(err as Error).message}`,
      );
      return { status: 'pending' };
    }
  }

  // ── Edición ───────────────────────────────────────────────────────────

  /**
   * Edición de un proveedor SWIFT. Los datos bancarios no se cambian (se crea
   * un proveedor nuevo, igual que con Bridge). Nombre, dirección, teléfono y
   * email del beneficiario se sincronizan con Tazapay; notas y email de
   * contacto son solo de Guira.
   *
   * Devuelve lo que hay que escribir en `suppliers`.
   */
  async buildUpdate(
    existing: Record<string, any>,
    userId: string,
    dto: UpdateSupplierDto,
  ): Promise<Record<string, unknown>> {
    const blocked: string[] = [];
    if (dto.payment_rail !== undefined && dto.payment_rail !== SWIFT_RAIL)
      blocked.push('payment_rail');
    if (
      dto.currency !== undefined &&
      dto.currency.toLowerCase() !== existing.currency
    )
      blocked.push('currency');
    const bankFieldNames = [
      'bank_name',
      'account_number',
      'routing_number',
      'checking_or_savings',
      'iban',
      'swift_bic',
      'iban_country',
      'clabe',
      'pix_key',
      'br_code',
      'bre_b_key',
      'sort_code',
      'bank_code',
      'document_type',
      'document_number',
      'phone_number',
      'wallet_address',
      'wallet_network',
      'wallet_currency',
      'cci',
      'address',
    ] as const;
    for (const f of bankFieldNames) {
      if ((dto as Record<string, unknown>)[f] !== undefined) blocked.push(f);
    }
    const swiftInput = dto.swift_fields ?? {};
    for (const key of Object.keys(swiftInput)) {
      const editable =
        EDITABLE_KEYS.has(key) ||
        EDITABLE_PREFIXES.some((p) => key.startsWith(p));
      if (!editable) blocked.push(key);
    }
    if (blocked.length > 0) {
      throw new BadRequestException(
        `No se pueden modificar los campos [${blocked.join(', ')}] de un beneficiario SWIFT. ` +
          'Para cambiar los datos bancarios crea un proveedor nuevo.',
      );
    }

    const updateData: Record<string, unknown> = {};
    if (dto.notes !== undefined) updateData.notes = dto.notes;

    const nameChanged =
      dto.name !== undefined && dto.name.trim() !== existing.name;
    const hasSwiftChanges = Object.keys(swiftInput).length > 0;
    if (!nameChanged && !hasSwiftChanges) return updateData;

    const name = (dto.name ?? existing.name ?? '').trim();
    if (name.length === 0 || name.length > 140) {
      throw new BadRequestException(
        'El nombre del beneficiario SWIFT debe tener entre 1 y 140 caracteres.',
      );
    }

    const { data: row } = await this.supabase
      .from('tazapay_beneficiaries')
      .select(
        'id, status, tazapay_beneficiary_id, beneficiary_type, country, currency',
      )
      .eq('supplier_id', existing.id)
      .maybeSingle();
    if (!row || row.status !== 'active' || !row.tazapay_beneficiary_id) {
      throw new BadRequestException(
        'Este beneficiario todavía se está registrando con el proveedor. Intenta editarlo en unos minutos.',
      );
    }

    const currentValues = bankDetailsToSwiftValues(existing.bank_details);
    const mergedInput: Record<string, unknown> = { ...currentValues };
    for (const [key, value] of Object.entries(swiftInput)) {
      mergedInput[key] = value ?? '';
    }

    let values = currentValues;
    if (hasSwiftChanges) {
      const schema = await this.corridors.getFormSchema(
        row.country as string,
        row.currency as string,
        row.beneficiary_type as BeneficiaryType,
      );
      if (!schema.available) {
        throw new BadRequestException({
          code: schema.reason,
          message: schema.message,
        });
      }
      // Solo se validan las claves que el esquema conoce: datos viejos que el
      // corredor ya no pide no deben bloquear la edición de la dirección.
      const known = new Set(schema.fields.map((f) => f.key));
      const scoped = Object.fromEntries(
        Object.entries(mergedInput).filter(([k]) => known.has(k)),
      );
      const result = this.corridors.validateAgainstSchema(schema, scoped);
      if (result.errors.length > 0) {
        throw new BadRequestException({
          code: 'SWIFT_FIELDS_INVALID',
          message: result.errors[0].message,
          errors: result.errors,
        });
      }
      values = { ...currentValues, ...result.values };
      for (const [key, value] of Object.entries(swiftInput)) {
        if (!value) delete values[key];
      }
    }

    // PUT a Tazapay solo con lo que se puede editar.
    const full = this.beneficiaries.buildPayload({
      userId,
      supplierId: existing.id,
      name,
      beneficiaryType: row.beneficiary_type as BeneficiaryType,
      country: row.country as string,
      currency: row.currency as string,
      values,
    });
    const putBody: Record<string, unknown> = { name: full.name };
    if (full.address) putBody.address = full.address;
    if (full.phone) putBody.phone = full.phone;
    if (full.email) putBody.email = full.email;

    try {
      await this.beneficiaries.update(
        row.tazapay_beneficiary_id as string,
        putBody,
      );
    } catch (err) {
      const mapped = this.beneficiaries.mapError(err);
      this.logger.warn(
        `PUT del beneficiario ${row.tazapay_beneficiary_id as string} falló: ${(err as Error).message}`,
      );
      throw new BadRequestException({
        code: 'SWIFT_PROVIDER_REJECTED',
        message: mapped.isValidation
          ? mapped.message
          : 'No pudimos actualizar el beneficiario con el proveedor. Intenta de nuevo en unos minutos.',
      });
    }

    if (nameChanged) updateData.name = name;
    if (hasSwiftChanges) {
      updateData.bank_details = swiftValuesToBankDetails(values, {
        bank_country: existing.bank_details?.bank_country,
        beneficiary_type: existing.bank_details?.beneficiary_type,
      });
    }
    return updateData;
  }

  // ── Baja ──────────────────────────────────────────────────────────────

  /**
   * Tazapay no tiene DELETE ni forma de desactivar un beneficiario: la baja
   * es solo en Guira.
   */
  async markInactive(supplierId: string): Promise<void> {
    const { error } = await this.supabase
      .from('tazapay_beneficiaries')
      .update({ status: 'inactive' })
      .eq('supplier_id', supplierId);
    if (error) {
      this.logger.error(
        `No se pudo marcar inactivo el beneficiario SWIFT del proveedor ${supplierId}: ${error.message}`,
      );
    }
  }

  // ── Lectura ───────────────────────────────────────────────────────────

  /**
   * Agrega el estado del alta en Tazapay a los proveedores SWIFT de la lista.
   * No consulta nada si no hay proveedores SWIFT.
   */
  async attachStatus<T extends { id: string; payment_rail?: string | null }>(
    suppliers: T[],
    opts: { includeProviderIds?: boolean } = {},
  ): Promise<Array<T & Partial<SwiftStatusInfo>>> {
    const swiftIds = suppliers
      .filter((s) => s.payment_rail === SWIFT_RAIL)
      .map((s) => s.id);
    if (swiftIds.length === 0) return suppliers;

    const { data, error } = await this.supabase
      .from('tazapay_beneficiaries')
      .select('supplier_id, status, tazapay_beneficiary_id, last_error_message')
      .in('supplier_id', swiftIds);
    if (error) {
      this.logger.warn(
        `No se pudo leer tazapay_beneficiaries: ${error.message}`,
      );
      return suppliers;
    }

    const bySupplier = new Map(
      (data ?? []).map((r) => [r.supplier_id as string, r]),
    );
    return suppliers.map((s) => {
      if (s.payment_rail !== SWIFT_RAIL) return s;
      const row = bySupplier.get(s.id);
      const info: Partial<SwiftStatusInfo> = {
        swift_status:
          (row?.status as SwiftStatusInfo['swift_status']) ?? 'pending',
      };
      if (opts.includeProviderIds) {
        info.tazapay_beneficiary_id =
          (row?.tazapay_beneficiary_id as string) ?? null;
        info.swift_last_error = (row?.last_error_message as string) ?? null;
      }
      return { ...s, ...info };
    });
  }

  // ── Reintentos ────────────────────────────────────────────────────────

  /**
   * Cada 5 minutos reintenta las altas que quedaron pendientes por una falla
   * técnica, con la misma idempotency key (si la primera llamada sí llegó a
   * Tazapay, devuelve el mismo bnf_). Pasadas 23 h se da por fallida.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, {
    name: 'tazapay-swift-beneficiaries-worker',
  })
  async retryPending(): Promise<void> {
    if (!this.beneficiaries.isConfigured) return;

    const minAge = new Date(Date.now() - PENDING_MIN_AGE_MS).toISOString();
    const { data: rows, error } = await this.supabase
      .from('tazapay_beneficiaries')
      .select(
        'id, user_id, supplier_id, idempotency_key, attempt_count, beneficiary_type, country, currency, created_at',
      )
      .eq('status', 'pending')
      .lt('updated_at', minAge)
      .order('updated_at', { ascending: true })
      .limit(20);
    if (error) {
      this.logger.warn(
        `Worker SWIFT: no se pudieron leer pendientes: ${error.message}`,
      );
      return;
    }

    for (const row of rows ?? []) {
      try {
        await this.retryOne(row);
      } catch (err) {
        this.logger.error(
          `Worker SWIFT: reintento de ${String(row.id)} falló: ${(err as Error).message}`,
        );
      }
    }
  }

  private async retryOne(row: Record<string, any>): Promise<void> {
    const ageHours =
      (Date.now() - new Date(row.created_at).getTime()) / 3600_000;

    const { data: supplier } = await this.supabase
      .from('suppliers')
      .select('id, user_id, name, bank_details, is_active')
      .eq('id', row.supplier_id)
      .maybeSingle();

    if (!supplier || !supplier.is_active) {
      await this.supabase
        .from('tazapay_beneficiaries')
        .update({ status: 'inactive' })
        .eq('id', row.id);
      return;
    }

    if (ageHours >= PENDING_GIVE_UP_HOURS) {
      await this.giveUp(row, supplier.name as string);
      return;
    }

    const payload = this.beneficiaries.buildPayload({
      userId: row.user_id,
      supplierId: row.supplier_id,
      name: supplier.name as string,
      beneficiaryType: row.beneficiary_type,
      country: row.country,
      currency: row.currency,
      values: bankDetailsToSwiftValues(
        supplier.bank_details as Record<string, unknown>,
      ),
    });
    const outcome = await this.submit(row as any, payload);

    if (outcome.status === 'rejected') {
      await this.supabase
        .from('suppliers')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', row.supplier_id);
      await this.notifyFailure(
        row.user_id,
        row.supplier_id,
        supplier.name as string,
        outcome.message,
      );
    } else if (outcome.status === 'active') {
      this.logger.log(
        `Worker SWIFT: beneficiario del proveedor ${String(row.supplier_id)} activo.`,
      );
    }
  }

  private async giveUp(
    row: Record<string, any>,
    supplierName: string,
  ): Promise<void> {
    await this.supabase
      .from('tazapay_beneficiaries')
      .update({
        status: 'failed',
        last_error_message: 'Sin respuesta del proveedor en 23 h',
      })
      .eq('id', row.id);
    await this.supabase
      .from('suppliers')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', row.supplier_id);
    await this.notifyFailure(
      row.user_id,
      row.supplier_id,
      supplierName,
      'No pudimos completar el registro con nuestro proveedor.',
    );
  }

  private async notifyFailure(
    userId: string,
    supplierId: string,
    supplierName: string,
    reason: string,
  ): Promise<void> {
    await this.notifications.sendNotification({
      userId,
      type: NotificationType.ALERT,
      title: 'No se pudo registrar tu beneficiario SWIFT',
      message:
        `La cuenta SWIFT de ${supplierName} no quedó registrada: ${reason} ` +
        'Revisa los datos y vuelve a registrarla.',
      link: '/proveedores',
      referenceType: 'supplier',
      referenceId: supplierId,
    });
  }
}
