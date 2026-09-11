import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CAPABILITY_KEY } from '../decorators/linked-access.decorator';
import type { Capability } from '../../common/constants/capabilities.constants';
import type { AuthenticatedUser } from './supabase-auth.guard';

/**
 * Guard global que gobierna el acceso vinculado: peticiones en las que
 * alguien lee la cuenta de otro (miembro del equipo de una empresa, o
 * contador externo) en vez de la suya.
 *
 * No hace nada cuando la petición es de un titular sobre sus propios
 * datos — el caso normal, que es el 100% del tráfico actual.
 *
 * Cuando SÍ hay contexto vinculado aplica dos puertas:
 *
 *   1) ¿El endpoint está marcado como alcanzable en este modo? Si no
 *      declara @RequiresCapability, se deniega. Esto mantiene la
 *      propiedad importante del diseño: cualquier ruta, presente o
 *      futura, está cerrada por omisión. Un endpoint nuevo escrito dentro
 *      de seis meses por alguien que no conoce este archivo no filtra
 *      nada.
 *
 *   2) ¿El permiso declarado está entre los que el titular concedió? Esta
 *      es la puerta que hace efectiva la elección del cliente al invitar.
 *
 * Debe registrarse DESPUÉS de SupabaseAuthGuard, que es quien resuelve y
 * adjunta `user.linkedAccess`.
 */
@Injectable()
export class LinkedAccessGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser | undefined;
    const linked = user?.linkedAccess;

    // Petición normal (el titular sobre sus propios datos): este guard no
    // participa. Las rutas siguen protegidas por SupabaseAuthGuard y
    // RolesGuard exactamente igual que antes.
    if (!linked) return true;

    const required = this.reflector.getAllAndOverride<Capability | undefined>(
      CAPABILITY_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required) {
      throw new ForbiddenException(
        'Esta sección no está disponible cuando consultas la cuenta de otra empresa.',
      );
    }

    if (!linked.capabilities.includes(required)) {
      throw new ForbiddenException(
        'No tienes permiso para ver esta información en esta cuenta.',
      );
    }

    return true;
  }
}
