import { BadRequestException, Logger } from '@nestjs/common';

const logger = new Logger('DatabaseError');

/**
 * Registra el error real de Postgres/Supabase en los logs del servidor y
 * lanza un BadRequestException con un mensaje genérico para el cliente,
 * evitando exponer detalles del esquema (tablas, columnas, constraints).
 */
export function throwDbError(error: { message: string }): never {
  logger.error(error.message);
  throw new BadRequestException(
    'No se pudo completar la operación. Intenta nuevamente.',
  );
}
