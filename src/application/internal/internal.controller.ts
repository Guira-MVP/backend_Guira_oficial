import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import { Public } from '../../core/guards/supabase-auth.guard';
import { NewUserAlertService } from './new-user-alert.service';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Endpoints llamados por la propia base de datos (pg_net), no por usuarios.
 * Se autentican con un secreto compartido en x-internal-secret.
 */
@ApiTags('Internal')
@Controller('internal')
export class InternalController {
  constructor(
    private readonly config: ConfigService,
    private readonly newUserAlert: NewUserAlertService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 300, ttl: 60000 } })
  @Post('new-user-alert')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async newUserAlertHook(
    @Headers('x-internal-secret') secret: string | undefined,
    @Body() body: { user_id?: string },
  ) {
    const expected = this.config.get<string>('app.internalWebhookSecret') ?? '';
    if (!expected || !secret || !safeEqual(secret, expected)) {
      throw new UnauthorizedException();
    }
    if (typeof body?.user_id === 'string' && UUID_RE.test(body.user_id)) {
      await this.newUserAlert.notify(body.user_id);
    }
    return { ok: true };
  }
}
