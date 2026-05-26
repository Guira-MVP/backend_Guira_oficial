import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  cors: { origin: '*', credentials: true },
  namespace: '/exchange-rates',
})
export class ExchangeRatesGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ExchangeRatesGateway.name);

  handleConnection(client: Socket) {
    this.logger.log(`Cliente conectado al WS exchange-rates: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Cliente desconectado del WS exchange-rates: ${client.id}`);
  }

  /**
   * Emite las tasas actualizadas a todos los clientes conectados.
   * El payload contiene el par, base_rate, spread_percent, effective_rate y updated_at.
   */
  emitRateUpdated(payload: {
    pair: string;
    base_rate: number;
    spread_percent: number;
    effective_rate: number;
    updated_at: string;
  }) {
    this.server.emit('rate_updated', payload);
    this.logger.log(`WS emitido: rate_updated para ${payload.pair}`);
  }
}
