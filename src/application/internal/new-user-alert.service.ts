import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { EmailService } from '../email/email.service';

const KEY_ENABLED = 'NEW_USER_ALERT_ENABLED';
const KEY_RECIPIENTS = 'NEW_USER_ALERT_RECIPIENTS';
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** Separa por coma/punto y coma, recorta, valida y quita duplicados. */
export function parseRecipients(raw: string | null | undefined): string[] {
  const seen = new Set<string>();
  for (const part of (raw ?? '').split(/[,;]/)) {
    const email = part.trim().toLowerCase();
    if (email && EMAIL_RE.test(email)) seen.add(email);
  }
  return [...seen];
}

/**
 * Aviso interno cuando un cliente nuevo verifica su correo. Lo invoca el
 * trigger de auth.users vía pg_net (ver InternalController). Nunca lanza:
 * un fallo aquí no debe afectar el registro del cliente.
 */
@Injectable()
export class NewUserAlertService {
  private readonly logger = new Logger(NewUserAlertService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly emailService: EmailService,
  ) {}

  async notify(userId: string): Promise<void> {
    try {
      const enabled = await this.getSetting(KEY_ENABLED);
      if (enabled === null || enabled.trim().toLowerCase() !== 'true') return;

      const { data: profile } = await this.supabase
        .from('profiles')
        .select('email, full_name, account_type, role, new_user_alert_sent_at')
        .eq('id', userId)
        .maybeSingle();

      if (!profile?.email) return;
      if (profile.role !== 'client') return;
      if (profile.account_type === 'member') return;
      if (profile.new_user_alert_sent_at) return;

      const recipients = parseRecipients(await this.getSetting(KEY_RECIPIENTS));
      if (!recipients.length) return;

      // Reserva atómica: solo un reintento/proceso gana y envía.
      const { data: claimed } = await this.supabase
        .from('profiles')
        .update({ new_user_alert_sent_at: new Date().toISOString() })
        .eq('id', userId)
        .is('new_user_alert_sent_at', null)
        .select('id');
      if (!claimed?.length) return;

      const sent = await this.emailService.sendNewUserAlertEmail(recipients, {
        email: profile.email as string,
        fullName: profile.full_name as string | null,
        accountType: profile.account_type as string | null,
        verifiedAt: new Date().toISOString(),
      });

      if (sent === 0) {
        // Ningún envío salió: liberar la reserva para que un reintento pueda enviar.
        await this.supabase
          .from('profiles')
          .update({ new_user_alert_sent_at: null })
          .eq('id', userId);
        this.logger.warn(`Aviso de nuevo cliente no enviado (user ${userId})`);
      }
    } catch (err) {
      this.logger.error(
        `Error en aviso de nuevo cliente (user ${userId}): ${(err as Error).message}`,
      );
    }
  }

  private async getSetting(key: string): Promise<string | null> {
    const { data } = await this.supabase
      .from('app_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    return data?.value != null ? String(data.value) : null;
  }
}
