// src/main.ts
import { NestFactory, Reflector } from '@nestjs/core';
import { AppModule } from './app.module';
import {
  ClassSerializerInterceptor,
  INestApplication,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Request, Response, NextFunction } from 'express';
import type { ServerOptions } from 'socket.io';

import helmet from 'helmet';
import { Server } from 'socket.io';

class CorsIoAdapter extends IoAdapter {
  private readonly app: INestApplication;
  private readonly allowedOrigins: string[];
  private ioServer: Server | null = null;

  constructor(app: INestApplication, origins: string[]) {
    super(app);
    this.app = app;
    this.allowedOrigins = origins;
  }

  createIOServer(port: number, options?: ServerOptions) {
    if (this.ioServer) {
      return this.ioServer;
    }

    // getHttpServer() only returns the live http.Server after listen(),
    // not during construction — so we access it lazily here.
    // Creating multiple engine.io Server instances on the same HTTP server
    // tears down prior request/upgrade listeners, so we cache a single one.
    this.ioServer = new Server(this.app.getHttpServer(), {
      ...options,
      cors: {
        ...(options?.cors || {}),
        origin: this.allowedOrigins,
        credentials: true,
      },
    });

    return this.ioServer;
  }
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // IMPORTANTE: Habilitamos rawBody para poder verificar firmas RSA/SHA256
  // de Bridge Webhooks sin interferir con FileInterceptor (Multer) o uploads.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // ALTO-01: Confiar en 1 hop de proxy (el load balancer de Render).
  // Con esto, Express deriva request.ip de forma segura a partir del
  // X-Forwarded-For inyectado por Render, ignorando cualquier valor que el
  // cliente intente spoofear. Imprescindible para que el rate limiting y el
  // logging de auditoría usen la IP real e inmanipulable.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

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

  // Adaptar Socket.IO con los mismos orígenes CORS que el REST
  app.useWebSocketAdapter(new CorsIoAdapter(app, allowedOrigins));

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
      'Idempotency-Key',
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

