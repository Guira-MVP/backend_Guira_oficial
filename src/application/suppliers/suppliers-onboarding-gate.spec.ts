import { ForbiddenException } from '@nestjs/common';
import { SuppliersController } from './suppliers.controller';
import type { AuthenticatedUser } from '../../core/guards/supabase-auth.guard';

/**
 * Desde el registro, un cliente sin onboarding aprobado recorre el panel en
 * vista previa. Puede ver su agenda de beneficiarios, pero crear, editar o
 * borrar tiene que fallar en el servidor aunque la interfaz lo deje pasar.
 */

function user(onboardingStatus: string): AuthenticatedUser {
  return {
    id: 'user-1',
    email: 'cliente@empresa.com',
    profile: { role: 'client', onboarding_status: onboardingStatus },
  } as unknown as AuthenticatedUser;
}

function setup() {
  const service = {
    create: jest.fn(() => Promise.resolve({ id: 's-1' })),
    update: jest.fn(() => Promise.resolve({ id: 's-1' })),
    remove: jest.fn(() => Promise.resolve({ ok: true })),
  };
  return { controller: new SuppliersController(service as never), service };
}

const SUPPLIER_ID = '22222222-2222-2222-2222-222222222222';

describe('SuppliersController — escrituras requieren onboarding aprobado', () => {
  it.each(['pending', 'kyb_started', 'in_review', 'pending_bridge'])(
    'rechaza crear, editar y borrar con estado %s',
    (status) => {
      const { controller, service } = setup();
      expect(() => controller.create(user(status), {} as never)).toThrow(
        ForbiddenException,
      );
      expect(() =>
        controller.update(SUPPLIER_ID, user(status), {} as never),
      ).toThrow(ForbiddenException);
      expect(() => controller.remove(SUPPLIER_ID, user(status))).toThrow(
        ForbiddenException,
      );
      expect(service.create).not.toHaveBeenCalled();
      expect(service.update).not.toHaveBeenCalled();
      expect(service.remove).not.toHaveBeenCalled();
    },
  );

  it('permite las escrituras a una cuenta aprobada', async () => {
    const { controller, service } = setup();
    await controller.create(user('approved'), {} as never);
    await controller.update(SUPPLIER_ID, user('approved'), {} as never);
    await controller.remove(SUPPLIER_ID, user('approved'));
    expect(service.create).toHaveBeenCalled();
    expect(service.update).toHaveBeenCalled();
    expect(service.remove).toHaveBeenCalled();
  });
});
