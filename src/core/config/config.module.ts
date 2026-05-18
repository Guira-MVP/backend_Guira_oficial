import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import * as Joi from 'joi';

import appConfig from './app/app.config';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      // En producción (Render/cloud) las vars se inyectan como env del sistema.
      // Solo cargamos el archivo .env.local en entornos locales de desarrollo.
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
