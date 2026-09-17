import { AdminSuppliersController } from './admin-suppliers.controller';

/**
 * Pruebas de `listByUser`: la traducción de query params (strings, siempre)
 * a los `opts` tipados que espera `SuppliersService.listByUserAdmin`.
 *
 * Lo que importa proteger aquí es que un `status` inválido no se cuele al
 * servicio (que asumiría que es uno de los cuatro valores válidos) y que
 * page/limit ausentes lleguen como `undefined`, no como `NaN` — con `NaN`,
 * `Math.max(1, NaN)` de listByUserAdmin da `NaN`, lo que rompería el rango.
 */
describe('AdminSuppliersController.listByUser', () => {
  function makeController() {
    const suppliersService = {
      listByUserAdmin: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    };
    const rescreening = {};
    const controller = new AdminSuppliersController(
      suppliersService as any,
      rescreening as any,
    );
    return { controller, suppliersService };
  }

  const userId = '11111111-1111-1111-1111-111111111111';

  it('pasa page y limit como números cuando vienen en la query', () => {
    const { controller, suppliersService } = makeController();

    controller.listByUser(userId, '3', '10', undefined, undefined, undefined);

    expect(suppliersService.listByUserAdmin).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ page: 3, limit: 10 }),
    );
  });

  it('deja page y limit en undefined cuando no vienen en la query', () => {
    const { controller, suppliersService } = makeController();

    controller.listByUser(
      userId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    expect(suppliersService.listByUserAdmin).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ page: undefined, limit: undefined }),
    );
  });

  it('pasa el rail tal cual', () => {
    const { controller, suppliersService } = makeController();

    controller.listByUser(
      userId,
      undefined,
      undefined,
      'crypto',
      undefined,
      undefined,
    );

    expect(suppliersService.listByUserAdmin).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ rail: 'crypto' }),
    );
  });

  it.each(['active', 'inactive', 'blocked', 'pending_review'])(
    'deja pasar el status válido "%s"',
    (status) => {
      const { controller, suppliersService } = makeController();

      controller.listByUser(
        userId,
        undefined,
        undefined,
        undefined,
        status,
        undefined,
      );

      expect(suppliersService.listByUserAdmin).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ status }),
      );
    },
  );

  it('descarta un status que no es uno de los cuatro válidos', () => {
    const { controller, suppliersService } = makeController();

    // 'compliant' no es un valor real de compliance_status — si se colara,
    // el servicio lo usaría en un .eq() que nunca matchea nada.
    controller.listByUser(
      userId,
      undefined,
      undefined,
      undefined,
      'compliant',
      undefined,
    );

    expect(suppliersService.listByUserAdmin).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ status: undefined }),
    );
  });

  it('pasa el término de búsqueda tal cual', () => {
    const { controller, suppliersService } = makeController();

    controller.listByUser(
      userId,
      undefined,
      undefined,
      undefined,
      undefined,
      'juan perez',
    );

    expect(suppliersService.listByUserAdmin).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ search: 'juan perez' }),
    );
  });

  it('devuelve la respuesta del servicio sin transformarla', async () => {
    const { controller, suppliersService } = makeController();
    const payload = { data: [{ id: 'sup-1' }], total: 1, page: 1, limit: 20 };
    suppliersService.listByUserAdmin.mockResolvedValueOnce(payload);

    await expect(
      controller.listByUser(
        userId,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    ).resolves.toBe(payload);
  });
});
