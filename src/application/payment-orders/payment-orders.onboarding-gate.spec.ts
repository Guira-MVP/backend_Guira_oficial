import { ForbiddenException } from '@nestjs/common';
import { PaymentOrdersService } from './payment-orders.service';

/**
 * Solo una cuenta verificada puede originar expedientes.
 *
 * Hasta que se añadió `assertOnboardingApproved`, esta regla vivía
 * únicamente en el enrutado del frontend: `AuthGuard` mandaba a
 * `/onboarding` a cualquier cliente sin aprobar, y el backend aceptaba la
 * orden de quien lograra llegar al endpoint. Se volvió alcanzable al
 * permitir que un invitado sin cuenta propia entrara al panel para
 * consultar la cuenta de otra empresa.
 *
 * Esta prueba existe para que la barrera no vuelva a depender de que la
 * interfaz acierte con la redirección.
 */
describe('PaymentOrdersService — cuenta sin verificar no puede crear expedientes', () => {
  function buildService(onboardingStatus: string | null) {
    const supabase: any = {
      from: jest.fn(() => supabase),
      select: jest.fn(() => supabase),
      eq: jest.fn(() => supabase),
      single: jest.fn(() =>
        Promise.resolve(
          onboardingStatus === null
            ? { data: null, error: { message: 'no encontrado' } }
            : { data: { onboarding_status: onboardingStatus }, error: null },
        ),
      ),
    };

    // Solo se ejercita la barrera, que corre antes que cualquier otra cosa:
    // el resto de colaboradores no llega a usarse.
    //
    // Los colaboradores van explícitos y no con un spread de Array(n).fill({}):
    // TypeScript no acepta esparcir un array sobre parámetros fijos (TS2556),
    // y además así el test falla al compilar si alguien cambia la firma del
    // constructor, en vez de pasar un número de argumentos silenciosamente mal.
    const service = new PaymentOrdersService(
      supabase,
      {} as any, // feesService
      {} as any, // psavService
      {} as any, // exchangeRatesService
      {} as any, // bridgeApi
      {} as any, // bankAccountsService
      {} as any, // orderReviewService
      {} as any, // notificationsService
      {} as any, // ordersGateway
      {} as any, // emailService
      {} as any, // pdfService
      {} as any, // flowReviewSettings
      {} as any, // suppliersService
    );

    return { service, supabase };
  }

  /** Acceso al método privado: es justo la barrera que se quiere fijar. */
  function assertApproved(service: PaymentOrdersService, userId: string) {
    return (
      service as unknown as {
        assertOnboardingApproved: (id: string) => Promise<void>;
      }
    ).assertOnboardingApproved(userId);
  }

  it('deja pasar a una cuenta aprobada', async () => {
    const { service } = buildService('approved');
    await expect(assertApproved(service, 'user-1')).resolves.toBeUndefined();
  });

  it.each([
    'pending',
    'in_progress',
    'kyc_started',
    'kyb_submitted',
    'in_review',
    'rejected',
    'suspended',
  ])('rechaza una cuenta en estado "%s"', async (status) => {
    const { service } = buildService(status);
    await expect(assertApproved(service, 'user-1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rechaza si no se puede leer el perfil', async () => {
    // Ante la duda, no se opera: el caso por defecto es el cerrado.
    const { service } = buildService(null);
    await expect(assertApproved(service, 'user-1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('consulta el perfil de quien crea, no otro', async () => {
    const { service, supabase } = buildService('approved');
    await assertApproved(service, 'user-42');

    expect(supabase.from).toHaveBeenCalledWith('profiles');
    expect(supabase.eq).toHaveBeenCalledWith('id', 'user-42');
  });
});
