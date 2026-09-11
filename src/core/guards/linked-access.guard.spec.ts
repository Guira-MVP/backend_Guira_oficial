import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LinkedAccessGuard } from './linked-access.guard';
import { CAPABILITY_KEY } from '../decorators/linked-access.decorator';

/**
 * Pruebas del guard que decide si una petición en modo vinculado puede
 * llegar a un endpoint.
 *
 * Es la pieza de la que depende que un miembro de equipo no pueda escribir:
 * merece cobertura directa y no solo la de los invariantes de código.
 */
describe('LinkedAccessGuard', () => {
  let guard: LinkedAccessGuard;
  let reflector: Reflector;

  /** Contexto mínimo: qué usuario viene y qué permiso declara el handler. */
  function contextFor(
    user: unknown,
    declaredCapability?: string,
  ): ExecutionContext {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockImplementation((key: unknown) =>
        key === CAPABILITY_KEY ? declaredCapability : undefined,
      );

    return {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    reflector = new Reflector();
    guard = new LinkedAccessGuard(reflector);
  });

  describe('peticiones normales (el titular sobre sus propios datos)', () => {
    it('deja pasar aunque el handler no declare permiso', () => {
      // Es el 100% del tráfico actual. Si este guard interfiriera aquí,
      // rompería la aplicación entera.
      const ctx = contextFor({ id: 'u1', linkedAccess: null });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('deja pasar cuando no hay usuario (ruta pública)', () => {
      const ctx = contextFor(undefined);
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });

  describe('peticiones en modo vinculado', () => {
    const linkedUser = {
      id: 'u2',
      linkedAccess: {
        ownerId: 'owner-1',
        source: 'team_member',
        capabilities: ['orders:read', 'activity:read'],
      },
    };

    it('DENIEGA si el handler no declara ningún permiso', () => {
      // La propiedad más importante del diseño: cualquier endpoint que no
      // se haya marcado explícitamente queda cerrado. Una ruta nueva
      // escrita dentro de seis meses no filtra nada por omisión.
      const ctx = contextFor(linkedUser, undefined);
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('DENIEGA si el permiso declarado no fue concedido', () => {
      const ctx = contextFor(linkedUser, 'balances:read');
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('permite si el permiso declarado fue concedido', () => {
      const ctx = contextFor(linkedUser, 'orders:read');
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('DENIEGA cuando el vínculo no tiene ningún permiso', () => {
      const ctx = contextFor(
        {
          id: 'u3',
          linkedAccess: {
            ownerId: 'owner-1',
            source: 'team_member',
            capabilities: [],
          },
        },
        'orders:read',
      );
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('no confunde permisos con prefijo común', () => {
      // 'orders:read' no debe habilitar 'orders:documents' por parecerse.
      const ctx = contextFor(linkedUser, 'orders:documents');
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('el mensaje de error no revela si el recurso existe', () => {
      const ctx = contextFor(linkedUser, 'balances:read');
      try {
        guard.canActivate(ctx);
        fail('debería haber lanzado');
      } catch (err) {
        const message = (err as ForbiddenException).message;
        expect(message).not.toContain('owner-1');
        expect(message).not.toContain('balances:read');
      }
    });
  });
});
