import { BadGatewayException } from '@nestjs/common';
import {
  BridgeApiClient,
  BridgeSourceAmountTooLowError,
} from './bridge-api.client';

/**
 * Error de Fixed Outputs "source.amount insuficiente". Bridge lo devuelve con
 * dos claves distintas según el entorno/documentación; en ambos casos el staff
 * debe recibir el mínimo exigido, y nada más del cuerpo del error (ALTO-02).
 */
describe('BridgeApiClient.post — source.amount insuficiente', () => {
  const originalFetch = global.fetch;

  function makeClient() {
    const config = {
      get: (key: string) =>
        key === 'app.bridgeApiKey'
          ? 'test-key'
          : 'https://api.sandbox.bridge.xyz',
    };
    const client = new BridgeApiClient(config as any);
    (client as any).logger = {
      error: jest.fn(),
      warn: jest.fn(),
      log: jest.fn(),
    };
    return client;
  }

  function mockBridgeResponse(status: number, body: unknown) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    }) as any;
  }

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('formato del sandbox: clave "source.amount"', async () => {
    mockBridgeResponse(400, {
      code: 'invalid_parameters',
      source: {
        location: 'body',
        key: {
          'source.amount':
            'must be at least 112.67 for destination amount of 100.0 with developer fee of 1.0',
        },
      },
    });

    const err = await makeClient()
      .post('/v0/transfers', {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeSourceAmountTooLowError);
    expect((err as BridgeSourceAmountTooLowError).minimumSourceAmount).toBe(
      112.67,
    );
  });

  it('formato de la guía de Fixed Outputs: clave "amount" con la moneda detrás', async () => {
    mockBridgeResponse(400, {
      code: 'invalid_parameters',
      source: {
        location: 'body',
        key: {
          amount:
            'must be at least 1030.00 USDC for destination amount of €850.00 EUR with developer fee of $10.00 USD',
        },
      },
    });

    const err = await makeClient()
      .post('/v0/transfers', {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeSourceAmountTooLowError);
    expect((err as BridgeSourceAmountTooLowError).minimumSourceAmount).toBe(
      1030,
    );
  });

  it('otros 400 siguen siendo el error genérico, sin exponer el cuerpo', async () => {
    mockBridgeResponse(400, {
      code: 'invalid_parameters',
      source: {
        location: 'body',
        key: { amount: 'is higher than the balance of the wallet' },
      },
    });

    const err = await makeClient()
      .post('/v0/transfers', {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadGatewayException);
    expect(err).not.toBeInstanceOf(BridgeSourceAmountTooLowError);
    expect((err as Error).message).not.toContain('balance');
  });
});
