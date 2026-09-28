import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../../core/guards/roles.guard';
import { ROLES_KEY } from '../../core/decorators/roles.decorator';
import { StaffOnboardingAssistController } from './staff-onboarding-assist.controller';

/**
 * Control de acceso del onboarding asistido (OWASP A01). El controlador
 * recibe el id del cliente en la URL, así que la única barrera frente a que
 * un cliente escriba en el borrador de otro es el rol. Estas pruebas fijan que
 * la restricción está a nivel de clase (cubre también rutas que se agreguen
 * después) y que RolesGuard la aplica.
 */

const HANDLERS = [
  'getContext',
  'saveDraft',
  'uploadDocument',
  'deleteDocument',
  'listDocuments',
  'getDocumentSignedUrl',
  'markReady',
] as const;

function contextFor(
  role: string | undefined,
  handler: (typeof HANDLERS)[number],
) {
  return {
    getHandler: () => StaffOnboardingAssistController.prototype[handler],
    getClass: () => StaffOnboardingAssistController,
    switchToHttp: () => ({
      getRequest: () => ({
        user: role ? { id: 'u1', profile: { role } } : undefined,
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('StaffOnboardingAssistController — acceso por rol', () => {
  const guard = new RolesGuard(new Reflector());

  it('declara los roles de staff a nivel de clase', () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, StaffOnboardingAssistController),
    ).toEqual(['staff', 'admin', 'super_admin']);
  });

  it.each(HANDLERS)('un cliente no puede llamar a %s', (handler) => {
    expect(() => guard.canActivate(contextFor('client', handler))).toThrow(
      ForbiddenException,
    );
  });

  it.each(HANDLERS)(
    'sin rol resuelto se deniega %s (fail-closed)',
    (handler) => {
      expect(() => guard.canActivate(contextFor(undefined, handler))).toThrow(
        ForbiddenException,
      );
    },
  );

  it.each(['staff', 'admin', 'super_admin'])('%s sí puede asistir', (role) => {
    for (const handler of HANDLERS) {
      expect(guard.canActivate(contextFor(role, handler))).toBe(true);
    }
  });

  it('no expone rutas de envío ni de aceptación de términos', () => {
    const methods = Object.getOwnPropertyNames(
      StaffOnboardingAssistController.prototype,
    );
    expect(methods.some((m) => /submit|tos|accept/i.test(m))).toBe(false);
  });
});
