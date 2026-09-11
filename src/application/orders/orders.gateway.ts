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
import { STAFF_ROLES } from '../../common/constants/roles.constants';

export interface ProfileStatusUpdatedPayload {
  user_id: string;
  onboarding_status: string;
  updated_at: string;
}

export interface WalletUpdatedPayload {
  user_id: string;
  currency: string;
  amount: number;
  available_amount: number;
  updated_at: string;
}

export interface OrderCreatedPayload {
  id: string;
  user_id: string;
  flow_type: string;
  flow_category: string;
  amount: number;
  currency: string;
  status: string;
  created_at: string;
}

export interface OrderUpdatedPayload {
  id: string;
  user_id: string;
  status: string;
  flow_type: string;
  updated_at: string;
  exchange_rate_applied?: number | null;
  amount_destination?: number | null;
  bridge_source_deposit_instructions?: Record<string, unknown> | null;
  // Instrucciones PSAV (cuenta bancaria donde deposita el cliente). Viajan por
  // el socket para que, al aprobar una revisión de staff, la pantalla del
  // cliente pase de "en revisión" a mostrar la cuenta sin recargar. Sin este
  // campo los 4 flujos PSAV quedarían destrabados a medias: verían el cambio
  // de estado pero no dónde depositar.
  psav_deposit_instructions?: Record<string, unknown> | null;
  // Motivo del cierre. Permite mostrar en vivo por qué el staff rechazó la
  // revisión, en vez de dejar al cliente esperando un aviso que ya no llegará.
  failure_reason?: string | null;
  // URLs de documentos: permiten que el detalle del staff refleje en vivo el
  // comprobante que sube el cliente sin recargar (mismo socket/evento ya existente).
  deposit_proof_url?: string | null;
  evidence_url?: string | null;
  supporting_document_url?: string | null;
}

@WebSocketGateway({
  namespace: '/orders',
})
export class OrdersGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(OrdersGateway.name);

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
        this.logger.warn(`Conexión WS /orders rechazada sin token: ${socket.id}`);
        return next(new Error('Token de autenticación requerido'));
      }

      const ephemeralClient = createClient(supabaseUrl, supabaseAnonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data, error } = await ephemeralClient.auth.getUser(token);

      if (error || !data?.user) {
        this.logger.warn(`Token WS /orders inválido de cliente ${socket.id}`);
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

    const role = await this.resolveRole(user.id);

    if (STAFF_ROLES.includes(role as (typeof STAFF_ROLES)[number])) {
      await client.join('staff');
      this.logger.log(
        `Staff conectado al WS /orders: ${client.id} (user: ${user.id}, role: ${role})`,
      );
    } else {
      await client.join(`user:${user.id}`);
      this.logger.log(
        `Cliente conectado al WS /orders: ${client.id} (user: ${user.id})`,
      );
    }
  }

  /**
   * Resuelve el rol del usuario desde `private.staff_members` vía el RPC
   * `staff_get`, igual que SupabaseAuthGuard.
   *
   * Antes esto leía `profiles.role`, que dejó de ser la fuente de verdad
   * cuando el rol se movió a `private.staff_members` (un cliente podía
   * escribir esa columna con la anon key y auto-promoverse). El guard HTTP
   * ya se corrigió en su momento; este gateway se quedó atrás y seguía
   * dando entrada al room `staff` según la columna vieja.
   *
   * Ante cualquier error se devuelve 'client': degradar, nunca conceder.
   */
  private async resolveRole(userId: string): Promise<string> {
    const { data, error } = await this.supabase.rpc('staff_get', {
      p_user_id: userId,
    });

    if (error) {
      this.logger.error(
        `No se pudo resolver el rol de staff para ${userId}: [${error.code}] ${error.message}`,
      );
      return 'client';
    }

    const member = Array.isArray(data) ? data[0] : data;
    if (!member || !member.is_active) return 'client';

    return member.role as string;
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Cliente desconectado del WS /orders: ${client.id}`);
  }

  /** Emite una nueva orden creada → solo al room `staff`. */
  emitOrderCreated(payload: OrderCreatedPayload) {
    this.server.to('staff').emit('order_created', payload);
    this.logger.log(
      `WS emitido: order_created por user:${payload.user_id} (id: ${payload.id})`,
    );
  }

  /** Emite actualización de estado → al usuario dueño y al room `staff`. */
  emitOrderUpdated(userId: string, payload: OrderUpdatedPayload) {
    this.server.to(`user:${userId}`).emit('order_updated', payload);
    this.server.to('staff').emit('order_updated', payload);
    this.logger.log(
      `WS emitido: order_updated para user:${userId} (id: ${payload.id}, status: ${payload.status})`,
    );
  }

  /** Emite cambio de estado de onboarding → solo al usuario dueño. */
  emitProfileStatusUpdated(userId: string, payload: ProfileStatusUpdatedPayload) {
    this.server.to(`user:${userId}`).emit('profile_status_updated', payload);
    this.logger.log(
      `WS emitido: profile_status_updated para user:${userId} (status: ${payload.onboarding_status})`,
    );
  }

  /** Emite actualización de balance → solo al usuario dueño. */
  emitWalletUpdated(userId: string, payload: WalletUpdatedPayload) {
    this.server.to(`user:${userId}`).emit('wallet_updated', payload);
    this.logger.log(
      `WS emitido: wallet_updated para user:${userId} (${payload.currency}: ${payload.amount})`,
    );
  }
}
