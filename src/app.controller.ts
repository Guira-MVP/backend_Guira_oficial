import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SupabaseClient } from '@supabase/supabase-js';
import { ConfigService } from '@nestjs/config';
import { AppService } from './app.service';
import { SUPABASE_CLIENT } from './core/supabase/supabase.module';
import { Public } from './core/guards/supabase-auth.guard';

@ApiTags('System')
@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Mensaje de bienvenida API' })
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  @Public()
  @ApiOperation({ summary: 'Healthcheck y estado del sistema' })
  async getHealth() {
    // Verificar DB
    const { error } = await this.supabase
      .from('profiles')
      .select('id')
      .limit(1);

    return {
      status: error ? 'degraded' : 'ok',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? '1.0.0',
      services: {
        database: error ? 'unreachable' : 'connected',
        bridge_api: this.config.get('app.bridgeApiKey')
          ? 'configured'
          : 'not_configured',
      },
    };
  }
}
