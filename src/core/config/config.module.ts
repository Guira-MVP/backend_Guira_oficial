import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import * as Joi from 'joi';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

import appConfig from './app/app.config';

// Carga el Secret File de Render en producción ANTES de que NestJS
// inicialice el ConfigModule. Render monta los Secret Files en
// /etc/secrets/<nombre> — el archivo .env.secrets contiene las
// variables sensibles (SUPABASE_SERVICE_ROLE_KEY, BRIDGE_API_KEY)
// que ya no están en las env vars del dashboard.
const RENDER_SECRETS_PATH = '/etc/secrets/.env.secrets';
if (fs.existsSync(RENDER_SECRETS_PATH)) {
  dotenv.config({ path: RENDER_SECRETS_PATH, override: false });
}

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
      validationSchema: Joi.object({
        // App
        NODE_ENV: Joi.string()
          .valid('development', 'test', 'production')
          .default('development'),
        PORT: Joi.number().default(3000),
        PATH_SUBDOMAIN: Joi.string().default('api'),
        URL_FRONTEND: Joi.string().allow('').default(''),

        // Supabase
        SUPABASE_URL: Joi.string().uri().required(),
        SUPABASE_ANON_KEY: Joi.string().required(),
        SUPABASE_SERVICE_ROLE_KEY: Joi.string().required(),

        // Bridge API
        // En producción BRIDGE_API_KEY es OBLIGATORIA — el servidor no arranca sin ella.
        BRIDGE_API_KEY: Joi.when('NODE_ENV', {
          is: 'production',
          then: Joi.string().required(),
          otherwise: Joi.string().allow('').default(''),
        }),
        BRIDGE_API_URL: Joi.string()
          .uri()
          .allow('')
          .default('https://api.bridge.xyz'),
        // En producción esta key es OBLIGATORIA para verificar firmas de webhooks
        BRIDGE_WEBHOOK_PUBLIC_KEY: Joi.when('NODE_ENV', {
          is: 'production',
          then: Joi.string().required(),
          otherwise: Joi.string().allow('').default(''),
        }),
      }),
    }),
  ],
  exports: [NestConfigModule],
})
export class CoreConfigModule {}
