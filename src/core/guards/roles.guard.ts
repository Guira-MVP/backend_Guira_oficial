import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, UserRole } from '../decorators/roles.decorator';

/**
 * Guard que verifica si el usuario autenticado tiene uno de los roles requeridos.
 * Debe usarse junto con @Roles('admin', 'staff', ...) en el controller/handler.
 *
 * Depende de que SupabaseAuthGuard haya enriquecido `request.user.profile`
 * con el campo `role` del perfil de la base de datos.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Si no se definieron roles, la ruta es accesible para cualquier autenticado
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const userRole: UserRole | undefined = request.user?.profile?.role;

    if (!userRole) {
      throw new ForbiddenException('No se pudo determinar el rol del usuario');
    }

    // super_admin tiene acceso a todo
    if (userRole === 'super_admin') {
      return true;
    }

    if (!requiredRoles.includes(userRole)) {
      throw new ForbiddenException(
        `Permisos insuficientes. Se requiere: ${requiredRoles.join(', ')}`,
      );
    }

    return true;
  }
}
