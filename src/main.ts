// src/main.ts
import { NestFactory, Reflector } from '@nestjs/core';
import { AppModule } from './app.module';
import {
  ClassSerializerInterceptor,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Request, Response, NextFunction } from 'express';

import helmet from 'helmet';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // IMPORTANTE: Habilitamos rawBody para poder verificar firmas RSA/SHA256
  // de Bridge Webhooks sin interferir con FileInterceptor (Multer) o uploads.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Prefijo global de la API
  const prefix = process.env.PATH_SUBDOMAIN || 'api';
  app.setGlobalPrefix(prefix);

  // CORS: acepta orígenes definidos en URL_FRONTEND (comma-separated)
  const allowedOrigins = (process.env.URL_FRONTEND ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter((o) => o.length > 0);

  // Localhost solo en entornos no-productivos
  if (process.env.NODE_ENV !== 'production') {
    if (!allowedOrigins.includes('http://localhost:3000')) {
      allowedOrigins.push('http://localhost:3000');
    }
    if (!allowedOrigins.includes('http://localhost:5173')) {
      allowedOrigins.push('http://localhost:5173');
    }
  }

  logger.log(`CORS allowed origins: ${allowedOrigins.join(', ')}`);

  // IMPORTANTE: enableCors ANTES de helmet para que las respuestas preflight (OPTIONS)
  // se envíen correctamente sin ser bloqueadas por helmet
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
    ],
  });

  // Security Headers — crossOriginResourcePolicy false para no bloquear peticiones cross-origin a la API
  app.use(helmet({ crossOriginResourcePolicy: false }));

  // Deshabilitar cache en todos los endpoints de la API
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Validación/transformación global de DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  // Render inyecta PORT automáticamente; default 3000 para producción
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;

  // Swagger — solo disponible en desarrollo y staging (no en producción)
  // En producción, /api/docs y /api/swagger/json devuelven 404.
  if (process.env.NODE_ENV !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Guira API')
      .setDescription('API de la plataforma financiera Guira')
      .setVersion('2.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'Token JWT de Supabase Auth (Authorization: Bearer <token>)',
        },
        'supabase-jwt',
      )
      .build();

    const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, swaggerDocument, {
      useGlobalPrefix: true,
      swaggerOptions: { persistAuthorization: true },
      jsonDocumentUrl: 'swagger/json',
    });

    logger.log(`Swagger docs: http://localhost:${port}/${prefix}/docs`);
  }

  // Habilitar cierre limpio (Graceful Shutdown)
  app.enableShutdownHooks();

  await app.listen(port, '0.0.0.0');
  logger.log(`Guira API running on port ${port} with prefix /${prefix} (0.0.0.0)`);
}
bootstrap();

