import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { CoreConfigModule } from './config/config.module';
import { SupabaseModule } from './supabase/supabase.module';
import { SupabaseAuthGuard } from './guards/supabase-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { PdfModule } from './pdf/pdf.module';

@Module({
  imports: [
    CoreConfigModule, // Variables de entorno + validación Joi
    SupabaseModule, // Cliente Supabase (service_role) — global
    PdfModule, // Generación de documentos PDF — global
    ScheduleModule.forRoot(), // CRON jobs con @nestjs/schedule
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100, // global limit 100 req per minute
      },
    ]),
  ],
  providers: [
    // Guard global: protección contra DdoS/Abuso rate limit
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    // Guard global: todas las rutas requieren autenticación
    // a menos que usen el decorador @Public()
    {
      provide: APP_GUARD,
      useClass: SupabaseAuthGuard,
    },
    // Guard global: verificación de roles — si el handler tiene @Roles(),
    // se valida que el usuario tenga el rol requerido.
    // Si no tiene @Roles(), permite acceso a cualquier usuario autenticado.
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class CoreModule {}
