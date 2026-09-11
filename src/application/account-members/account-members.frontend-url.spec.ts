import { ConfigService } from '@nestjs/config';
import { AccountMembersService } from './account-members.service';

/**
 * Regresión del bug real de producción: el enlace de invitación llegó al
 * correo como `http:///invitacion-equipo?token=...` (dominio vacío) porque
 * el servicio leía la clave de config equivocada (`app.frontendUrl` en vez
 * de `app.urlFrontend`) y no tenía resguardo ante `undefined`.
 *
 * Se accede al getter privado vía índice de tipo porque es exactamente lo
 * que produce la URL rota si algo vuelve a desalinearse; probar el efecto
 * en vez de la causa haría que este test sobreviviera a una regresión
 * futura con un nombre de clave distinto.
 */
describe('AccountMembersService — frontendUrl', () => {
  function buildService(configValue: string | undefined): AccountMembersService {
    const configService = {
      get: (key: string) => (key === 'app.urlFrontend' ? configValue : undefined),
    } as unknown as ConfigService;

    return new AccountMembersService(
      {} as any, // supabase — no se usa en este getter
      configService,
      {} as any, // emailService — no se usa en este getter
    );
  }

  function frontendUrlOf(service: AccountMembersService): string {
    return (service as unknown as { frontendUrl: string }).frontendUrl;
  }

  it('lee la clave real app.urlFrontend, no una inexistente', () => {
    const service = buildService('https://guira.example');
    expect(frontendUrlOf(service)).toBe('https://guira.example');
  });

  it('cae a localhost cuando la variable de entorno no está configurada', () => {
    // Es lo que faltaba: sin esto, el enlace de invitación se arma como
    // ruta relativa y el correo llega con un dominio vacío.
    const service = buildService(undefined);
    expect(frontendUrlOf(service)).toBe('http://localhost:3000');
  });

  it('usa el primer origen cuando hay varios separados por coma', () => {
    const service = buildService('https://a.guira.com,https://b.guira.com');
    expect(frontendUrlOf(service)).toBe('https://a.guira.com');
  });

  it('nunca produce una URL con dominio vacío', () => {
    for (const value of [undefined, '', '   ']) {
      const url = frontendUrlOf(buildService(value));
      expect(url).not.toBe('');
      expect(`${url}/invitacion-equipo?token=x`).not.toMatch(/^https?:\/\/\//);
    }
  });
});
