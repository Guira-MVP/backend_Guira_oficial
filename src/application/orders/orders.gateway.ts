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
}

const STAFF_ROLES = ['staff', 'admin', 'super_admin'];

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

    // Fetch role from profiles using service-role client
    const { data: profile } = await this.supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    const role = profile?.role ?? 'client';

    if (STAFF_ROLES.includes(role)) {
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
