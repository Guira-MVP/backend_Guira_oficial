import { ConsoleLogger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

/**
 * El ConsoleLogger de Nest escribe directo a process.stdout/stderr, no a
 * console.*, así que consoleLoggingIntegration() de Sentry nunca lo ve.
 * Este logger reenvía warn()/error() a Sentry explícitamente — log()/debug()/
 * verbose() se quedan solo en la consola para no gastar cuota de logs.
 */
export class SentryAwareLogger extends ConsoleLogger {
  error(message: unknown, ...optionalParams: any[]): void {
    super.error(message, ...optionalParams);

    if (message instanceof Error) {
      Sentry.captureException(message);
      return;
    }

    const stack = optionalParams.find((p) => typeof p === 'string');
    if (typeof stack === 'string' && stack.includes('\n')) {
      // Nest pasa el stack trace como segundo argumento cuando se llama
      // logger.error(mensaje, error.stack) — lo tratamos como excepción real.
      const err = new Error(String(message));
      err.stack = stack;
      Sentry.captureException(err);
      return;
    }

    Sentry.logger.error(String(message));
  }

  warn(message: unknown, ...optionalParams: any[]): void {
    super.warn(message, ...optionalParams);
    Sentry.logger.warn(String(message));
  }
}
