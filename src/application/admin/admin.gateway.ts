import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Server, Socket } from 'socket.io';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';

// ── Payload interfaces ────────────────────────────────────────────

export interface UserUpdatedPayload {
  id: string;
  role: string;
  is_active: boolean;
  is_frozen: boolean;
  frozen_reason: string | null;
  onboarding_status: string;
  bridge_customer_id: string | null;
  updated_at: string;
}

export interface FeeConfigUpdatedPayload {
  id: string;
  operation_type: string | null;
  payment_rail: string | null;
  currency: string | null;
  fee_type: string | null;
  fee_percent: number | null;
  fee_fixed: number | null;
  min_fee: number | null;
  max_fee: number | null;
  is_active: boolean;
  updated_at: string;
  action: 'created' | 'updated';
}

export interface AppSettingUpdatedPayload {
  key: string; // PK — app_settings no tiene columna id
  value: string | null;
  updated_at: string;
  action: 'created' | 'updated';
}

export interface PsavConfigUpdatedPayload {
  id: string;
  name: string;
  type: string;
  currency: string;
  is_active: boolean;
  updated_at: string;
  action: 'created' | 'updated';
}

// ── Gateway ───────────────────────────────────────────────────────

const STAFF_ROLES = ['staff', 'admin', 'super_admin'];

@WebSocketGateway({
  namespace: '/admin',
})
export class AdminGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AdminGateway.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  afterInit() {
    const supabaseUrl = this.configService.get<string>('app.supabaseUrl')!;
    const supabaseAnonKey =
      this.configService.get<string>('app.supabaseAnonKey')!;

    this.server.use(async (socket, next) => {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');

      if (!token) {
        this.logger.warn(
          `Conexión WS /admin rechazada sin token: ${socket.id}`,
        );
        return next(new Error('Token de autenticación requerido'));
      }

      const ephemeralClient = createClient(supabaseUrl, supabaseAnonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data, error } = await ephemeralClient.auth.getUser(token);

      if (error || !data?.user) {
        this.logger.warn(`Token WS /admin inválido de cliente ${socket.id}`);
        return next(new Error('Token inválido o expirado'));
      }

      socket.data.user = {
        id: data.user.id,
        email: data.user.email ?? '',
      };
      next();
    });
  }

  async handleConnection(client: Socket) {
    const user = client.data?.user;
    if (!user?.id) return;

    // Solo staff/admin acceden a este namespace — verificar rol
    const { data: profile } = await this.supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    const role = profile?.role ?? 'client';

    if (!STAFF_ROLES.includes(role)) {
      this.logger.warn(
        `WS /admin: acceso denegado para user ${user.id} (role: ${role}) — desconectando`,
      );
      client.disconnect(true);
      return;
    }

    await client.join('staff');
    this.logger.log(
      `Staff conectado al WS /admin: ${client.id} (user: ${user.id}, role: ${role})`,
    );
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Cliente desconectado del WS /admin: ${client.id}`);
  }

  // ── Emit methods — todos al room `staff` ─────────────────────────

  /** Perfil de usuario modificado (rol, estado activo/congelado, etc.). */
  emitUserUpdated(payload: UserUpdatedPayload) {
    this.server.to('staff').emit('user_updated', payload);
    this.logger.log(
      `WS emitido: user_updated (id: ${payload.id}, role: ${payload.role})`,
    );
  }

  /** Tarifa de fees_config creada o actualizada. */
  emitFeeConfigUpdated(payload: FeeConfigUpdatedPayload) {
    this.server.to('staff').emit('fee_config_updated', payload);
    this.logger.log(
      `WS emitido: fee_config_updated (id: ${payload.id}, action: ${payload.action})`,
    );
  }

  /** Ajuste de app_settings creado o actualizado. */
  emitAppSettingUpdated(payload: AppSettingUpdatedPayload) {
    this.server.to('staff').emit('app_setting_updated', payload);
    this.logger.log(
      `WS emitido: app_setting_updated (key: ${payload.key}, action: ${payload.action})`,
    );
  }

  /** Cuenta PSAV creada o actualizada. */
  emitPsavConfigUpdated(payload: PsavConfigUpdatedPayload) {
    this.server.to('staff').emit('psav_config_updated', payload);
    this.logger.log(
      `WS emitido: psav_config_updated (id: ${payload.id}, action: ${payload.action})`,
    );
  }
}
