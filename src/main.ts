// src/main.ts
import './instrument'; // Sentry: debe ser el primer import del archivo

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
import { SentryAwareLogger } from './core/logging/sentry-aware.logger';
import {
  isSwaggerEnabledAppEnv,
  resolveCorsOrigins,
  resolveAppEnv,
} from './core/config/app/app-env';
import { CLOUDFLARE_CIDRS } from './core/config/cloudflare-ips';

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
  const appEnv = resolveAppEnv();

  // IMPORTANTE: Habilitamos rawBody para poder verificar firmas RSA/SHA256
  // de Bridge Webhooks sin interferir con FileInterceptor (Multer) o uploads.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Reemplaza el logger por defecto para que warn()/error() de cualquier
  // servicio también se reporten a Sentry (ver sentry-aware.logger.ts).
  app.useLogger(new SentryAwareLogger());

  // ALTO-01: Proxies de confianza declarados como lista de CIDRs, no como un
  // contador de saltos.
  //
  // Antes esto era `set('trust proxy', 1)`, que asumía un único proxy delante
  // (el load balancer de Render). Al poner Cloudflare por delante pasaron a
  // ser dos saltos — cliente -> Cloudflare -> Render -> Express — y Express
  // empezó a resolver request.ip como la IP del edge de Cloudflare en vez de
  // la del usuario. Efecto medido en producción: desde julio de 2026, el 100%
  // de los eventos de auth_audit_log quedaron registrados con IP de
  // Cloudflare, y el rate limiting por IP agrupaba a todos los usuarios en un
  // puñado de IPs de borde compartidas.
  //
  // Con una lista de subredes, proxy-addr recorre X-Forwarded-For de derecha a
  // izquierda y se queda con la primera dirección NO confiable — que es
  // justamente la del cliente. Además el valor deja de ser falsificable: una
  // IP inyectada por el cliente nunca cae dentro de los rangos de confianza,
  // así que se detiene ahí.
  //
  //   Vía Cloudflare:  XFF = <falsa>, <cliente>, <edge_CF>  -> request.ip = <cliente>
  //   Directo a Render: XFF = <falsa>, <atacante>           -> request.ip = <atacante>
  //   Staging (sin CF): XFF = <cliente>                     -> request.ip = <cliente>
  //
  // La misma configuración vale para los dos entornos, así que no hace falta
  // ramificar por APP_ENV: en staging simplemente no llega tráfico desde los
  // rangos de Cloudflare. `trust proxy: 2` habría arreglado producción pero
  // sería falsificable y rompería staging.
  //
  // loopback/linklocal/uniquelocal cubren el proxy interno de Render.
  app
    .getHttpAdapter()
    .getInstance()
    .set('trust proxy', [
      'loopback',
      'linklocal',
      'uniquelocal',
      ...CLOUDFLARE_CIDRS,
    ]);

  // Prefijo global de la API
  const prefix = process.env.PATH_SUBDOMAIN || 'api';
  app.setGlobalPrefix(prefix);

  // CORS: URL_FRONTEND (comma-separated) plus localhost only in dev/test.
  const allowedOrigins = resolveCorsOrigins(appEnv, process.env.URL_FRONTEND);

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
  if (isSwaggerEnabledAppEnv(appEnv)) {
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
  logger.log(
    `Guira API running on port ${port} with prefix /${prefix} (${appEnv})`,
  );
}
bootstrap();
