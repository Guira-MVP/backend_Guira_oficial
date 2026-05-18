import { SetMetadata } from '@nestjs/common';

export type UserRole = 'client' | 'staff' | 'admin' | 'super_admin';

export const ROLES_KEY = 'roles';

/**
 * Decorador para restringir acceso a roles específicos.
 * Uso: @Roles('admin', 'super_admin')
 * Requiere que RolesGuard esté activo en la ruta.
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
