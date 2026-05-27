import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { Server, Socket } from 'socket.io';

export interface RateUpdatedPayload {
  pair: string;
  base_rate: number;
  spread_percent: number;
  effective_rate: number;
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
    this.logger.log(
      `Cliente conectado al WS exchange-rates: ${client.id}` +
        (userId ? ` (user: ${userId})` : ''),
    );
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Cliente desconectado del WS exchange-rates: ${client.id}`);
  }

  emitRateUpdated(payload: RateUpdatedPayload) {
    this.server.emit('rate_updated', payload);
    this.logger.log(`WS emitido: rate_updated para ${payload.pair}`);
  }
}
