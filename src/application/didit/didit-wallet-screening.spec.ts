import { DiditWalletScreeningService } from './didit-wallet-screening.service';

/**
 * Pruebas del screening AML de la dirección cripto de un beneficiario.
 *
 * Lo que se protege aquí es la política de negocio: bloqueo duro SOLO si hay
 * sanciones o riesgo crítico, y ningún fallo del proveedor (caído, apagado,
 * red sin cobertura) puede impedir que el cliente registre un beneficiario.
 */

function mockSupabase(opts: { enabled?: string | null; settingError?: string }) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () =>
      Promise.resolve(
        opts.settingError
          ? { data: null, error: { message: opts.settingError } }
          : { data: opts.enabled === undefined ? null : { value: opts.enabled }, error: null },
      ),
  };

  return { from: jest.fn(() => builder) } as any;
}

function mockApi(overrides: Record<string, unknown> = {}) {
  return {
    isConfigured: true,
    screenWallet: jest.fn(),
    ...overrides,
  } as any;
}

/** Respuesta de dirección limpia: score 0, sin sanciones, solo exchanges. */
function cleanResult() {
  return {
    provider: 'merklescience',
    risk_score: 0,
    severity: 'UNKNOWN',
    status: 'SCREENED',
    summary: 'Sin exposición adversa',
    blockchain: 'ETH',
    sanctions_hit: false,
    dominant_risk_category: null,
    risk_factors: [],
  };
}

const INPUT = {
  walletAddress: '0x28c6c06298d514db089934071355e5743bf21d60',
  walletNetwork: 'ethereum',
  userId: 'user-1',
};

describe('DiditWalletScreeningService', () => {
  it('no llama a Didit cuando el interruptor está apagado', async () => {
    const api = mockApi();
    const service = new DiditWalletScreeningService(mockSupabase({ enabled: 'false' }), api);

    const verdict = await service.screenBeneficiaryWallet(INPUT);

    expect(api.screenWallet).not.toHaveBeenCalled();
    expect(verdict.status).toBe('Skipped');
    expect(verdict.decision).toBe('allow');
    expect(verdict.skip_reason).toContain('deshabilitada');
  });

  it('está apagado por defecto: sin la fila en app_settings no se screenea', async () => {
    // Defensa clave del despliegue: hasta que alguien cree y active la clave,
    // el flujo de creación de beneficiarios se comporta exactamente como hoy.
    const api = mockApi();
    const service = new DiditWalletScreeningService(mockSupabase({}), api);

    const verdict = await service.screenBeneficiaryWallet(INPUT);

    expect(api.screenWallet).not.toHaveBeenCalled();
    expect(verdict.decision).toBe('allow');
  });

  it('si falla la lectura de app_settings no screenea y deja crear', async () => {
    const api = mockApi();
    const service = new DiditWalletScreeningService(
      mockSupabase({ settingError: 'connection reset' }),
      api,
    );

    const verdict = await service.screenBeneficiaryWallet(INPUT);

    expect(api.screenWallet).not.toHaveBeenCalled();
    expect(verdict.decision).toBe('allow');
  });

  it('omite el screening si la API key no está configurada', async () => {
    const api = mockApi({ isConfigured: false });
    const service = new DiditWalletScreeningService(mockSupabase({ enabled: 'true' }), api);

    const verdict = await service.screenBeneficiaryWallet(INPUT);

    expect(api.screenWallet).not.toHaveBeenCalled();
    expect(verdict.status).toBe('Skipped');
    expect(verdict.decision).toBe('allow');
  });

  it('omite las redes sin cobertura en Didit sin llamar a la API', async () => {
    // `base` y `stellar` están en ALLOWED_NETWORKS de Guira pero Didit no las
    // soporta: enviarlas daría 400 y se cobraría el intento fallido de nada.
    const api = mockApi();
    const service = new DiditWalletScreeningService(mockSupabase({ enabled: 'true' }), api);

    for (const walletNetwork of ['base', 'stellar']) {
      const verdict = await service.screenBeneficiaryWallet({ ...INPUT, walletNetwork });
      expect(verdict.status).toBe('Skipped');
      expect(verdict.decision).toBe('allow');
      expect(verdict.skip_reason).toContain(walletNetwork);
    }

    expect(api.screenWallet).not.toHaveBeenCalled();
  });

  it('mapea cada red soportada a su identificador de Didit', async () => {
    const api = mockApi({ screenWallet: jest.fn().mockResolvedValue(cleanResult()) });
    const service = new DiditWalletScreeningService(mockSupabase({ enabled: 'true' }), api);

    const expected: Array<[string, string]> = [
      ['ethereum', 'ETH'],
      ['solana', 'SOL'],
      ['tron', 'TRX'],
      ['polygon', 'MATIC'],
    ];

    for (const [walletNetwork, blockchain] of expected) {
      await service.screenBeneficiaryWallet({ ...INPUT, walletNetwork });
      expect(api.screenWallet).toHaveBeenLastCalledWith({
        walletAddress: INPUT.walletAddress,
        blockchain,
      });
    }
  });

  it('aprueba una dirección limpia', async () => {
    const api = mockApi({ screenWallet: jest.fn().mockResolvedValue(cleanResult()) });
    const service = new DiditWalletScreeningService(mockSupabase({ enabled: 'true' }), api);

    const verdict = await service.screenBeneficiaryWallet(INPUT);

    expect(verdict.status).toBe('Approved');
    expect(verdict.decision).toBe('allow');
    // El score crudo se conserva: `UNKNOWN` es la banda 0-9, no un "sin datos",
    // así que un 1-9 debe poder distinguirse de un 0 limpio.
    expect(verdict.risk_score).toBe(0);
  });

  it('BLOQUEA cuando hay sanciones, incluso con severidad baja', async () => {
    // El bloqueo no depende solo de la banda: sanctions_hit manda.
    const api = mockApi({
      screenWallet: jest.fn().mockResolvedValue({
        ...cleanResult(),
        risk_score: 30,
        severity: 'LOW',
        sanctions_hit: true,
      }),
    });
    const service = new DiditWalletScreeningService(mockSupabase({ enabled: 'true' }), api);

    const verdict = await service.screenBeneficiaryWallet(INPUT);

    expect(verdict.status).toBe('Declined');
    expect(verdict.decision).toBe('block');
  });

  it('BLOQUEA con severidad CRITICAL aunque no haya sanciones', async () => {
    const api = mockApi({
      screenWallet: jest.fn().mockResolvedValue({
        ...cleanResult(),
        risk_score: 95,
        severity: 'CRITICAL',
        sanctions_hit: false,
        dominant_risk_category: 'mixer',
      }),
    });
    const service = new DiditWalletScreeningService(mockSupabase({ enabled: 'true' }), api);

    const verdict = await service.screenBeneficiaryWallet(INPUT);

    expect(verdict.decision).toBe('block');
    expect(verdict.dominant_risk_category).toBe('mixer');
  });

  it('marca (sin bloquear) las severidades HIGH y MEDIUM', async () => {
    for (const severity of ['HIGH', 'MEDIUM']) {
      const api = mockApi({
        screenWallet: jest.fn().mockResolvedValue({ ...cleanResult(), risk_score: 55, severity }),
      });
      const service = new DiditWalletScreeningService(mockSupabase({ enabled: 'true' }), api);

      const verdict = await service.screenBeneficiaryWallet(INPUT);

      expect(verdict.status).toBe('In Review');
      expect(verdict.decision).toBe('flag');
    }
  });

  it('deja pasar LOW sin marcar', async () => {
    const api = mockApi({
      screenWallet: jest
        .fn()
        .mockResolvedValue({ ...cleanResult(), risk_score: 20, severity: 'LOW' }),
    });
    const service = new DiditWalletScreeningService(mockSupabase({ enabled: 'true' }), api);

    const verdict = await service.screenBeneficiaryWallet(INPUT);

    expect(verdict.status).toBe('Approved');
    expect(verdict.decision).toBe('allow');
  });

  it('no bloquea cuando el proveedor devuelve ERROR o PENDING', async () => {
    // Sin veredicto no hay nada que aplicar: el beneficiario se crea y el
    // estado queda registrado para el staff.
    for (const [status, expectedStatus] of [
      ['ERROR', 'Error'],
      ['PENDING', 'In Review'],
    ]) {
      const api = mockApi({
        screenWallet: jest.fn().mockResolvedValue({ ...cleanResult(), status }),
      });
      const service = new DiditWalletScreeningService(mockSupabase({ enabled: 'true' }), api);

      const verdict = await service.screenBeneficiaryWallet(INPUT);

      expect(verdict.status).toBe(expectedStatus);
      expect(verdict.decision).toBe('allow');
    }
  });

  it('si Didit está caído devuelve Error sin lanzar, y deja crear', async () => {
    // El caso del 409 (sin proveedor de monitoreo configurado) entra por aquí.
    const api = mockApi({
      screenWallet: jest.fn().mockRejectedValue(new Error('Didit no tiene proveedor configurado')),
    });
    const service = new DiditWalletScreeningService(mockSupabase({ enabled: 'true' }), api);

    const verdict = await service.screenBeneficiaryWallet(INPUT);

    expect(verdict.status).toBe('Error');
    expect(verdict.decision).toBe('allow');
    expect(verdict.error_message).toContain('proveedor');
  });

  it('lee risk_factors ausente como lista vacía', async () => {
    // Los resultados anteriores a que existiera el campo omiten la clave.
    const { risk_factors, ...withoutFactors } = cleanResult();
    const api = mockApi({ screenWallet: jest.fn().mockResolvedValue(withoutFactors) });
    const service = new DiditWalletScreeningService(mockSupabase({ enabled: 'true' }), api);

    const verdict = await service.screenBeneficiaryWallet(INPUT);

    expect(risk_factors).toEqual([]);
    expect(verdict.risk_factors).toEqual([]);
  });
});
