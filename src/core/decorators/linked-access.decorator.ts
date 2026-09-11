import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Capability } from '../../common/constants/capabilities.constants';
import type { AuthenticatedUser } from '../guards/supabase-auth.guard';

export const CAPABILITY_KEY = 'requiredCapability';

/**
 * Marca un endpoint como alcanzable en modo vinculado (miembro de equipo
 * o contador externo actuando sobre la cuenta de otro) y declara el
 * permiso concreto que hace falta.
 *
 * Sin este decorador, LinkedAccessGuard devuelve 403 — es decir, el modo
 * por defecto de cualquier endpoint, existente o futuro, es NO accesible
 * en delegación. Añadir una ruta nueva sin conocer este diseño no abre
 * ningún hueco: falla cerrado.
 *
 * Recibe UN SOLO permiso a propósito. Si un endpoint dependiera de dos,
 * los permisos dejarían de ser independientes entre sí y habría que
 * probar sus combinaciones (2^n) en vez de cada permiso por separado (n).
 *
 * Uso: @Get() @RequiresCapability('orders:read')
 *
 * Solo debe usarse en handlers @Get. Hay un test que recorre todas las
 * rutas y falla si aparece en un método de escritura.
 */
export const RequiresCapability = (capability: Capability) =>
  SetMetadata(CAPABILITY_KEY, capability);

/**
 * Devuelve el id de la cuenta cuyos datos hay que leer: la del titular si
 * la petición viene en modo vinculado, la propia en caso contrario.
 *
 * Solo debe usarse en handlers @Get. En escrituras se usa `@CurrentUser()`,
 * que devuelve SIEMPRE la identidad de quien inició sesión. Esa separación
 * es deliberada: si un endpoint de escritura se colara en modo vinculado,
 * escribiría sobre la cuenta del propio invitado y no sobre la del cliente.
 */
export const TargetUserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser | undefined;
    return user?.linkedAccess?.ownerId ?? user?.id ?? '';
  },
);

/**
 * Contexto vinculado de la petición, o `null` si es el titular sobre sus
 * propios datos.
 *
 * Lo necesitan los handlers que además de filtrar tienen que **recortar**
 * lo que devuelven — el enmascarado de datos bancarios, por ejemplo. Eso
 * no se puede resolver con `@RequiresCapability`, que decide si se entra
 * al endpoint pero no cómo se serializa la respuesta.
 */
export const LinkedAccess = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser | undefined;
    return user?.linkedAccess ?? null;
  },
);
