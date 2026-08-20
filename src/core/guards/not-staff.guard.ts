import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedUser } from './supabase-auth.guard';

/**
 * Impide que el personal interno inicie el onboarding de Bridge.
 *
 * Las cuentas del panel son identidades corporativas: existen para operar la
 * plataforma, no para mover dinero a través de ella. Vincularlas a un customer
 * de Bridge mezcla el rol de operador con el de cliente, lo que rompe la
 * separación de funciones y deja al mismo usuario a ambos lados de una
 * revisión de cumplimiento.
 *
 * Quien trabaje aquí y además quiera operar debe hacerlo con una cuenta de
 * cliente aparte, a su nombre y con su correo personal.
 *
 * Depende de que SupabaseAuthGuard haya resuelto `request.user.profile.role`
 * contra private.staff_members.
 */
@Injectable()
export class NotStaffGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request.user;

    if (user && user.profile?.role !== 'client') {
      throw new ForbiddenException(
        'Las cuentas del personal no pueden completar el onboarding. Si necesitas operar, usa una cuenta de cliente con tu correo personal.',
      );
    }

    return true;
  }
}
