import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createClient } from '@supabase/supabase-js';
import { Server, Socket } from 'socket.io';

export interface RateUpdatedPayload {
  pair: string;
  base_rate: number;
  spread_percent: number;
  effective_rate: number;
  bridge_buy_rate: number | null;
  bridge_sell_rate: number | null;
  updated_at: string;
}

@WebSocketGateway({
  namespace: '/exchange-rates',
})
export class ExchangeRatesGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ExchangeRatesGateway.name);

  /** Sockets abiertos en el namespace. Contador propio en lugar de leer el
   * interno de Socket.IO, que cambia entre versiones. */
  private activeConnections = 0;

  constructor(private readonly configService: ConfigService) {}

  afterInit() {
    const supabaseUrl = this.configService.get<string>('app.supabaseUrl')!;
    const supabaseAnonKey = this.configService.get<string>('app.supabaseAnonKey')!;

    this.server.use(async (socket, next) => {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');

      if (!token) {
        this.logger.warn(`Conexión WS rechazada sin token: ${socket.id}`);
        return next(new Error('Token de autenticación requerido'));
      }

      const ephemeralClient = createClient(supabaseUrl, supabaseAnonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data, error } = await ephemeralClient.auth.getUser(token);

      if (error || !data?.user) {
        this.logger.warn(`Token WS inválido de cliente ${socket.id}`);
        return next(new Error('Token inválido o expirado'));
      }

      socket.data.user = {
        id: data.user.id,
        email: data.user.email ?? '',
      };
      next();
    });
  }

  handleConnection(client: Socket) {
    const userId = client.data?.user?.id;
    this.activeConnections++;
    this.logger.log(
      `Cliente conectado al WS exchange-rates: ${client.id}` +
        (userId ? ` (user: ${userId})` : '') +
        ` [activas: ${this.activeConnections}]`,
    );
  }

  handleDisconnect(client: Socket) {
    this.activeConnections = Math.max(0, this.activeConnections - 1);
    this.logger.log(
      `Cliente desconectado del WS exchange-rates: ${client.id}` +
        ` [activas: ${this.activeConnections}]`,
    );
  }

  /**
   * Emite una sola tasa. Se conserva para la ruta manual del admin, donde solo
   * cambia un par y no tiene sentido agrupar.
   */
  emitRateUpdated(payload: RateUpdatedPayload) {
    this.server.emit('rate_updated', payload);
    this.logger.log(`WS emitido: rate_updated para ${payload.pair}`);
  }

  /**
   * Emite todas las tasas de un ciclo del cron en un único frame.
   *
   * El cron actualiza 17 pares por ciclo; emitirlos uno a uno generaba 17
   * frames escalonados a lo largo de ~2,5 s, cada uno con su propio overhead
   * de protocolo, y 17 renders en el cliente. Un solo evento cubre lo mismo.
   */
  emitRatesBatch(payloads: RateUpdatedPayload[]) {
    if (payloads.length === 0) return;
    this.server.emit('rates_updated', payloads);
    this.logger.log(`WS emitido: rates_updated (${payloads.length} pares)`);
  }

  /**
   * Sonda de diagnóstico: sin ella no hay forma de saber cuántos sockets
   * quedan abiertos fuera de horario, que es lo que determina si conviene
   * segmentar los broadcasts por par.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  logConnectionCount() {
    this.logger.log(
      `WS exchange-rates: ${this.activeConnections} conexiones activas`,
    );
  }
}
