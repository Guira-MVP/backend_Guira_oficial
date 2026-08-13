import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

import appConfig from './app/app.config';
import { resolveAppEnv } from './app/app-env';
import { environmentValidationSchema } from './environment.validation';

// Carga el Secret File de Render en producción ANTES de que NestJS
// inicialice el ConfigModule. Render monta los Secret Files en
// /etc/secrets/<nombre> — el archivo .env.secrets contiene las
// variables sensibles (SUPABASE_SERVICE_ROLE_KEY, BRIDGE_API_KEY)
// que ya no están en las env vars del dashboard.
const RENDER_SECRETS_PATH = '/etc/secrets/.env.secrets';
if (fs.existsSync(RENDER_SECRETS_PATH)) {
  dotenv.config({ path: RENDER_SECRETS_PATH, override: false });
}

// APP_ENV identifies the application tier. Populate its documented fallback
// before Joi runs so production validation remains strict when it is omitted.
process.env.APP_ENV ??= resolveAppEnv();

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      // En producción: las vars no-sensibles vienen del dashboard de Render.
      // Las sensibles (SERVICE_ROLE_KEY, BRIDGE_API_KEY) se cargaron arriba
      // desde el Secret File /etc/secrets/.env.secrets.
      // En desarrollo: cargamos .env.local completo.
      envFilePath:
        process.env.NODE_ENV === 'production' ? undefined : '.env.local',
      load: [appConfig],
      expandVariables: true,
      validationSchema: environmentValidationSchema,
    }),
  ],
  exports: [NestConfigModule],
})
export class CoreConfigModule {}
