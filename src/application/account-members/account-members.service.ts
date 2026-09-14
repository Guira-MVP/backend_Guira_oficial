import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'crypto';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { EmailService } from '../email/email.service';
import type { AuthenticatedUser } from '../../core/guards/supabase-auth.guard';
import {
  CAPABILITY_LABELS,
  Capability,
  PRESET_LABELS,
  Preset,
  resolveCapabilities,
} from '../../common/constants/capabilities.constants';
import {
  AccountMemberResponse,
  InviteMemberDto,
  LinkedAccountResponse,
  MAX_ACTIVE_MEMBERS,
  ReopenInvitationDto,
  UpdateMemberCapabilitiesDto,
} from './dto/account-members.dto';
import { InvitationThrottleService } from './invitation-throttle.service';

const INVITATION_TTL_DAYS = 7;

@Injectable()
export class AccountMembersService {
  private readonly logger = new Logger(AccountMembersService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
    private readonly throttle: InvitationThrottleService,
  ) {}

  /**
   * Solo una cuenta con el onboarding aprobado puede mandar invitaciones.
   *
   * La pantalla `/equipo` ya exige `approved` para renderizarse, pero el
   * endpoint no lo comprobaba: con un JWT válido, una cuenta registrada
   * hace treinta segundos y sin KYB podía hacer que Guira enviara correos
   * con su marca a cualquier dirección, con su propio `full_name`
   * incrustado en el cuerpo. El tope de 20 tampoco lo frenaba, porque
   * cuenta solo `pending + active`: cancelando se libera el hueco.
   *
   * Es la misma barrera que `assertOnboardingApproved` en las órdenes de
   * pago, por el mismo motivo: la protección de la interfaz no vale para
   * un endpoint que se puede llamar directamente.
   */
  private async assertCanInvite(actor: AuthenticatedUser): Promise<void> {
    const { data: profile, error } = await this.supabase
      .from('profiles')
      .select('onboarding_status')
      .eq('id', actor.id)
      .single();

    if (error || !profile) {
      this.logger.error(
        `No se pudo verificar el onboarding de ${actor.id}: ${error?.message}`,
      );
      throw new ForbiddenException('No se pudo verificar tu cuenta.');
    }

    if (profile.onboarding_status !== 'approved') {
      throw new ForbiddenException(
        'Termina la verificación de tu cuenta para poder invitar a tu equipo.',
      );
    }
  }

  /**
   * `app.frontendUrl` no existe: la clave real es `app.urlFrontend` (ver
   * `staff-admin.service.ts`, que ya la usa así). Con la clave equivocada
   * esto siempre devolvía `undefined`, y sin el resguardo de
   * `staff-admin.service.ts` el enlace de invitación se armaba como una
   * URL relativa (`/invitacion-equipo?token=...`). Gmail, al no poder
   * resolver el host, le antepone `http://` y el resultado visible es
   * `http:///invitacion-equipo?token=...` — tres barras, dominio vacío.
   *
   * `URL_FRONTEND` puede traer varios orígenes separados por coma (CORS);
   * el enlace usa el primero.
   */
  private get frontendUrl(): string {
    return (
      this.configService
        .get<string>('app.urlFrontend')
        ?.split(',')[0]
        ?.trim() || 'http://localhost:3000'
    );
  }

  // ═══════════════════════════════════════════════
  //  Utilidades
  // ═══════════════════════════════════════════════

  /**
   * El token viaja en claro solo por correo; en la base queda su hash.
   * Mismo criterio que cualquier credencial: quien lea la tabla no puede
   * usar lo que ve para aceptar una invitación ajena.
   */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async audit(entry: {
    actor: AuthenticatedUser;
    action: string;
    targetId: string;
    previous?: Record<string, unknown> | null;
    next?: Record<string, unknown> | null;
    reason?: string | null;
  }): Promise<void> {
    await this.supabase.from('audit_logs').insert({
      performed_by: entry.actor.id,
      role: entry.actor.profile.role,
      action: entry.action,
      table_name: 'account_members',
      record_id: entry.targetId,
      previous_values: entry.previous ?? null,
      new_values: entry.next ?? null,
      reason: entry.reason ?? null,
      source: 'client_panel',
    });
  }

  /**
   * Marca como expiradas las invitaciones vencidas de una cuenta.
   *
   * Se hace de forma perezosa, al consultar, en vez de con un cron: el
   * estado 'pending' vencido nunca concede acceso (resolveLinkedAccess solo
   * mira 'active'), así que esto es cosmético — sirve para que el titular
   * vea "caducada" en vez de "pendiente" eternamente.
   */
  private async expireStale(ownerId: string): Promise<void> {
    await this.supabase
      .from('account_members')
      .update({ status: 'expired' })
      .eq('owner_id', ownerId)
      .eq('status', 'pending')
      .lt('expires_at', new Date().toISOString());
  }

  private toResponse(row: Record<string, any>): AccountMemberResponse {
    return {
      id: row.id,
      member_id: row.member_id ?? null,
      invited_email: row.invited_email,
      full_name: row.full_name ?? null,
      preset: row.preset,
      capabilities: (row.capabilities ?? []) as Capability[],
      status: row.status,
      invited_at: row.created_at,
      accepted_at: row.accepted_at ?? null,
      expires_at: row.expires_at ?? null,
      // `member_id` y no `accepted_at`: al reabrir una invitación el
      // `accepted_at` se sobrescribe, pero `member_id` conserva que esa
      // persona llegó a tener cuenta vinculada alguna vez.
      was_accepted: row.member_id != null,
    };
  }

  // ═══════════════════════════════════════════════
  //  Lado del titular
  // ═══════════════════════════════════════════════

  async list(ownerId: string): Promise<AccountMemberResponse[]> {
    await this.expireStale(ownerId);

    const { data, error } = await this.supabase
      .from('account_members')
      .select('*')
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(`Error listando el equipo de ${ownerId}: ${error.message}`);
      throw new InternalServerErrorException('No se pudo consultar el equipo');
    }

    return (data ?? []).map((row) => this.toResponse(row));
  }

  async invite(
    actor: AuthenticatedUser,
    dto: InviteMemberDto,
  ): Promise<{ member: AccountMemberResponse; email_sent: boolean }> {
    const email = dto.email.trim().toLowerCase();

    // Invitarse a uno mismo no tiene sentido y además chocaría con el
    // CHECK de la tabla al aceptar.
    if (email === actor.email.trim().toLowerCase()) {
      throw new BadRequestException('No puedes invitarte a ti mismo.');
    }

    await this.assertCanInvite(actor);
    await this.throttle.consume(actor.id, email);
    await this.expireStale(actor.id);

    const { count } = await this.supabase
      .from('account_members')
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', actor.id)
      .in('status', ['pending', 'active']);

    if ((count ?? 0) >= MAX_ACTIVE_MEMBERS) {
      throw new BadRequestException(
        `Has alcanzado el máximo de ${MAX_ACTIVE_MEMBERS} personas en tu equipo.`,
      );
    }

    const capabilities = resolveCapabilities(dto.preset, dto.capabilities);
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(
      Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    const { data, error } = await this.supabase
      .from('account_members')
      .insert({
        owner_id: actor.id,
        invited_email: email,
        full_name: dto.full_name.trim(),
        preset: dto.preset,
        capabilities,
        status: 'pending',
        invited_by: actor.id,
        invitation_token_hash: this.hashToken(token),
        expires_at: expiresAt.toISOString(),
      })
      .select('*')
      .single();

    if (error) {
      // 23505 = violación del índice único parcial: ya hay un vínculo vivo.
      if (error.code === '23505') {
        throw new BadRequestException(
          'Esa persona ya está invitada o ya forma parte de tu equipo.',
        );
      }
      this.logger.error(`Error invitando a ${email}: ${error.message}`);
      throw new InternalServerErrorException('No se pudo crear la invitación');
    }

    const emailSent = await this.sendInvite({
      email,
      fullName: dto.full_name,
      token,
      companyName: actor.profile.full_name ?? 'Una empresa',
      preset: dto.preset,
      capabilities,
    });

    await this.audit({
      actor,
      action: 'TEAM_MEMBER_INVITED',
      targetId: data.id,
      next: { invited_email: email, preset: dto.preset, capabilities },
    });

    return { member: this.toResponse(data), email_sent: emailSent };
  }

  private async sendInvite(params: {
    email: string;
    fullName: string;
    token: string;
    companyName: string;
    preset: Preset;
    capabilities: Capability[];
  }): Promise<boolean> {
    const inviteUrl = `${this.frontendUrl}/invitacion-equipo?token=${params.token}`;

    try {
      return await this.emailService.sendTeamInviteEmail(
        { email: params.email, name: params.fullName },
        {
          inviteUrl,
          companyName: params.companyName,
          presetLabel: PRESET_LABELS[params.preset],
          capabilityLabels: params.capabilities.map(
            (cap) => CAPABILITY_LABELS[cap],
          ),
        },
      );
    } catch (err) {
      this.logger.error(
        `No se pudo enviar la invitación a ${params.email}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  async updateCapabilities(
    actor: AuthenticatedUser,
    memberRowId: string,
    dto: UpdateMemberCapabilitiesDto,
  ): Promise<AccountMemberResponse> {
    const current = await this.findOwnedRow(actor.id, memberRowId);

    if (current.status === 'revoked') {
      throw new BadRequestException(
        'Este acceso está revocado. Vuelve a invitar a la persona si quieres darle acceso otra vez.',
      );
    }

    const capabilities = resolveCapabilities(dto.preset, dto.capabilities);

    const { data, error } = await this.supabase
      .from('account_members')
      .update({ preset: dto.preset, capabilities })
      .eq('id', memberRowId)
      .eq('owner_id', actor.id)
      .select('*')
      .single();

    if (error) {
      this.logger.error(
        `Error actualizando permisos de ${memberRowId}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        'No se pudieron actualizar los permisos',
      );
    }

    // Antes y después, no solo "se modificó": en una revisión hay que poder
    // reconstruir qué permisos tuvo cada persona y entre qué fechas.
    await this.audit({
      actor,
      action: 'TEAM_MEMBER_CAPABILITIES_UPDATED',
      targetId: memberRowId,
      previous: { preset: current.preset, capabilities: current.capabilities },
      next: { preset: dto.preset, capabilities },
      reason: dto.reason,
    });

    return this.toResponse(data);
  }

  async revoke(
    actor: AuthenticatedUser,
    memberRowId: string,
    reason: string,
  ): Promise<AccountMemberResponse> {
    const current = await this.findOwnedRow(actor.id, memberRowId);

    if (current.status === 'revoked') {
      return this.toResponse(current);
    }

    const { data, error } = await this.supabase
      .from('account_members')
      .update({
        status: 'revoked',
        revoked_at: new Date().toISOString(),
        revoked_by: actor.id,
        revoke_reason: reason,
      })
      .eq('id', memberRowId)
      .eq('owner_id', actor.id)
      .select('*')
      .single();

    if (error) {
      this.logger.error(`Error revocando ${memberRowId}: ${error.message}`);
      throw new InternalServerErrorException('No se pudo revocar el acceso');
    }

    await this.audit({
      actor,
      action: 'TEAM_MEMBER_REVOKED',
      targetId: memberRowId,
      previous: { status: current.status },
      next: { status: 'revoked' },
      reason,
    });

    return this.toResponse(data);
  }

  /**
   * Reabre una invitación sobre la misma fila.
   *
   * Un solo mecanismo para los dos botones de la pantalla: «Reenviar» sobre
   * una pendiente o caducada, y «Volver a invitar» sobre una retirada. La
   * diferencia es si el titular manda permisos nuevos.
   *
   * Existe porque sin él el sistema se atasca: el índice único
   * `account_members_unique_live` cubre (owner_id, correo) para pending y
   * active, así que si la invitación se perdió en el correo y sigue
   * pendiente, invitar otra vez devuelve 23505 — y la única salida era
   * «Retirar acceso» (cuyo diálogo afirma algo falso: esa persona nunca
   * tuvo acceso) y volver a empezar. Siete días atrapado.
   */
  async reopen(
    actor: AuthenticatedUser,
    memberRowId: string,
    dto: ReopenInvitationDto,
  ): Promise<{ member: AccountMemberResponse; email_sent: boolean }> {
    const current = await this.findOwnedRow(actor.id, memberRowId);

    if (current.status === 'active') {
      throw new BadRequestException(
        'Esa persona ya tiene acceso a tu cuenta.',
      );
    }

    await this.assertCanInvite(actor);

    // El cupo se consume ANTES de tocar la fila: si está agotado, la
    // invitación que ya se mandó debe seguir siendo válida.
    await this.throttle.consume(actor.id, current.invited_email as string);

    // Volver a dar acceso ocupa una plaza del equipo otra vez. Se cuentan
    // las vivas excluyendo esta fila, que ahora mismo no lo está.
    const { count } = await this.supabase
      .from('account_members')
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', actor.id)
      .in('status', ['pending', 'active'])
      .neq('id', memberRowId);

    if ((count ?? 0) >= MAX_ACTIVE_MEMBERS) {
      throw new BadRequestException(
        `Has alcanzado el máximo de ${MAX_ACTIVE_MEMBERS} personas en tu equipo.`,
      );
    }

    // Sin permisos nuevos se conservan los de la invitación. Con ellos se
    // vuelven a resolver contra el catálogo ACTUAL: si un permiso se retiró
    // del catálogo desde que se concedió —como pasó con `compliance:read`—,
    // reabrir a ciegas lo reintroduciría.
    const capabilities = dto.preset
      ? resolveCapabilities(dto.preset, dto.capabilities)
      : resolveCapabilities(
          current.preset as Preset,
          (current.capabilities ?? []) as Capability[],
        );

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(
      Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    const { data, error } = await this.supabase
      .from('account_members')
      .update({
        status: 'pending',
        preset: dto.preset ?? current.preset,
        capabilities,
        // Token nuevo siempre: un enlace viejo que se hubiera filtrado deja
        // de servir en cuanto se reabre.
        invitation_token_hash: this.hashToken(token),
        expires_at: expiresAt.toISOString(),
        // Se limpia el rastro de la revocación anterior; el histórico de
        // quién la retiró y por qué vive en audit_logs.
        revoked_at: null,
        revoked_by: null,
        revoke_reason: null,
      })
      .eq('id', memberRowId)
      .eq('owner_id', actor.id)
      .select('*')
      .single();

    if (error) {
      // 23505: mientras esta fila estaba retirada, se invitó de nuevo al
      // mismo correo y esa invitación sigue viva.
      if (error.code === '23505') {
        throw new BadRequestException(
          'Ya hay una invitación activa para ese correo.',
        );
      }
      this.logger.error(`Error reabriendo ${memberRowId}: ${error.message}`);
      throw new InternalServerErrorException(
        'No se pudo reenviar la invitación',
      );
    }

    const emailSent = await this.sendInvite({
      email: data.invited_email,
      fullName: data.full_name ?? data.invited_email,
      token,
      companyName: actor.profile.full_name ?? 'Una empresa',
      preset: data.preset,
      capabilities,
    });

    await this.audit({
      actor,
      action: 'TEAM_MEMBER_INVITE_REOPENED',
      targetId: memberRowId,
      previous: { status: current.status, capabilities: current.capabilities },
      next: { status: 'pending', capabilities },
    });

    return { member: this.toResponse(data), email_sent: emailSent };
  }

  private async findOwnedRow(
    ownerId: string,
    rowId: string,
  ): Promise<Record<string, any>> {
    const { data, error } = await this.supabase
      .from('account_members')
      .select('*')
      .eq('id', rowId)
      .eq('owner_id', ownerId)
      .maybeSingle();

    if (error) {
      this.logger.error(`Error consultando ${rowId}: ${error.message}`);
      throw new InternalServerErrorException('No se pudo consultar el acceso');
    }

    if (!data) {
      throw new NotFoundException('Acceso no encontrado');
    }

    return data;
  }

  // ═══════════════════════════════════════════════
  //  Lado del invitado
  // ═══════════════════════════════════════════════

  /**
   * Acepta una invitación.
   *
   * El token demuestra que la persona recibió el correo; la comparación de
   * correos demuestra que es la destinataria. Hacen falta las dos: sin la
   * segunda, reenviar el enlace a un tercero le daría acceso a los datos de
   * una empresa que no lo autorizó.
   */
  async accept(
    actor: AuthenticatedUser,
    token: string,
  ): Promise<AccountMemberResponse> {
    const { data: row, error } = await this.supabase
      .from('account_members')
      .select('*')
      .eq('invitation_token_hash', this.hashToken(token))
      .maybeSingle();

    if (error) {
      this.logger.error(`Error resolviendo invitación: ${error.message}`);
      throw new InternalServerErrorException(
        'No se pudo procesar la invitación',
      );
    }

    if (!row) {
      throw new NotFoundException(
        'Esta invitación ya no es válida. Pide que te la reenvíen.',
      );
    }

    // Reabrir el enlace del correo después de haber aceptado es lo más
    // normal del mundo —el correo sigue en la bandeja—, así que no puede
    // responder "ya no es válida" como si algo hubiera fallado. Si es la
    // misma persona y ya tiene el acceso, se responde que sí, con lo que
    // la pantalla muestra "invitación aceptada" en vez de un error.
    if (row.status === 'active' && row.member_id === actor.id) {
      return this.toResponse(row);
    }

    if (row.status === 'active') {
      throw new ForbiddenException(
        'Esta invitación ya fue usada por otra persona.',
      );
    }

    if (row.status === 'revoked') {
      throw new BadRequestException(
        'El acceso a esta cuenta fue retirado. Pide una invitación nueva.',
      );
    }

    if (row.status !== 'pending') {
      throw new BadRequestException(
        'La invitación caducó. Pide que te la reenvíen.',
      );
    }

    if (new Date(row.expires_at) < new Date()) {
      await this.supabase
        .from('account_members')
        .update({ status: 'expired' })
        .eq('id', row.id);
      throw new BadRequestException(
        'La invitación caducó. Pide que te la reenvíen.',
      );
    }

    if (
      row.invited_email.trim().toLowerCase() !==
      actor.email.trim().toLowerCase()
    ) {
      throw new ForbiddenException(
        'Esta invitación es para otra dirección de correo. Inicia sesión con la cuenta a la que fue enviada.',
      );
    }

    // Ya hay un índice único que impide dos vínculos activos con la misma
    // cuenta, pero conviene comprobarlo antes: así la persona lee que ya
    // tiene acceso en vez de recibir un error de base de datos.
    const { data: existing } = await this.supabase
      .from('account_members')
      .select('id')
      .eq('owner_id', row.owner_id)
      .eq('member_id', actor.id)
      .eq('status', 'active')
      .maybeSingle();

    if (existing) {
      throw new BadRequestException(
        'Ya tienes acceso a esta cuenta. Puedes consultarla desde el selector del panel.',
      );
    }

    const { data, error: updateError } = await this.supabase
      .from('account_members')
      .update({
        member_id: actor.id,
        status: 'active',
        accepted_at: new Date().toISOString(),
        // El token NO se borra a propósito. El uso único ya lo garantiza el
        // estado: arriba se rechaza cualquier fila que no esté 'pending'.
        // Borrarlo no añadía seguridad (es un hash, irreversible) y en
        // cambio impedía reconocer la invitación al reabrir el enlace, que
        // es como se llegaba al mensaje "ya no es válida".
      })
      .eq('id', row.id)
      .eq('status', 'pending') // evita la carrera de dos aceptaciones
      .select('*')
      .maybeSingle();

    // Sin filas: otra petición ganó la carrera y ya la aceptó. Pasa con un
    // doble clic en el botón. No es un error del sistema, así que no se
    // responde 500: el resultado que la persona esperaba ya ocurrió.
    if (!updateError && !data) {
      throw new BadRequestException(
        'Esta invitación ya fue aceptada. Recarga la página.',
      );
    }

    if (updateError || !data) {
      this.logger.error(
        `Error aceptando invitación ${row.id}: ${updateError?.message}`,
      );
      throw new InternalServerErrorException(
        'No se pudo aceptar la invitación',
      );
    }

    await this.audit({
      actor,
      action: 'TEAM_MEMBER_ACCEPTED',
      targetId: row.id,
      next: { member_id: actor.id, owner_id: row.owner_id },
    });

    return this.toResponse(data);
  }

  /** Cuentas que este usuario puede consultar. Alimenta el selector. */
  async myLinkedAccounts(userId: string): Promise<LinkedAccountResponse[]> {
    const { data, error } = await this.supabase
      .from('account_members')
      .select('owner_id, preset, capabilities')
      .eq('member_id', userId)
      .eq('status', 'active');

    if (error) {
      this.logger.error(
        `Error listando accesos de ${userId}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        'No se pudieron consultar tus accesos',
      );
    }

    const rows = data ?? [];
    if (rows.length === 0) return [];

    const { data: owners } = await this.supabase
      .from('profiles')
      .select('id, full_name')
      .in(
        'id',
        rows.map((row) => row.owner_id),
      );

    const nameById = new Map(
      (owners ?? []).map((owner) => [owner.id, owner.full_name]),
    );

    return rows.map((row) => ({
      owner_id: row.owner_id,
      company_name: nameById.get(row.owner_id) ?? null,
      preset: row.preset as Preset,
      capabilities: (row.capabilities ?? []) as Capability[],
    }));
  }
}
