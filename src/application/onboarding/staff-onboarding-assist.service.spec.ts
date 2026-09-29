import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StaffOnboardingAssistService } from './staff-onboarding-assist.service';
import type { AuthenticatedUser } from '../../core/guards/supabase-auth.guard';
import type { SaveOnboardingDraftDto } from './dto/save-onboarding-draft.dto';

/**
 * Onboarding asistido: el staff escribe en el borrador de un cliente. Las
 * reglas que no pueden fallar:
 *   - solo sobre clientes activos, no aprobados y que no sean personal interno;
 *   - la auditoría registra al staff como actor y nunca el contenido;
 *   - "listo" avisa al cliente (notificación + correo).
 */

const CLIENT = '11111111-1111-1111-1111-111111111111';

const actor = {
  id: 'staff-1',
  email: 'sistemas@guiracorp.com',
  profile: { role: 'staff', onboarding_status: 'approved' },
} as unknown as AuthenticatedUser;

interface ProfileRow {
  id: string;
  email: string | null;
  full_name: string | null;
  company_name: string | null;
  tax_id: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_id_number: string | null;
  phone: string | null;
  onboarding_status: string;
  account_type: 'personal' | 'company' | null;
  is_active: boolean;
  is_frozen: boolean;
}

function clientProfile(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    id: CLIENT,
    email: 'cliente@empresa.com',
    full_name: 'María Pérez',
    company_name: 'Empresa S.R.L.',
    tax_id: '1020304025',
    contact_first_name: 'María',
    contact_last_name: 'Pérez',
    contact_id_number: '1234567',
    phone: '+59171234567',
    onboarding_status: 'pending',
    account_type: 'company',
    is_active: true,
    is_frozen: false,
    ...overrides,
  };
}

function setup(
  opts: {
    profile?: ProfileRow | null;
    staffMember?: boolean;
    emailConfirmed?: boolean;
    sameTaxId?: number;
  } = {},
) {
  const audits: Array<Record<string, unknown>> = [];
  const profile = opts.profile === undefined ? clientProfile() : opts.profile;

  const supabase = {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: () => b,
        neq: () => b,
        order: () => b,
        limit: () => b,
        // Conteo de otras cuentas con el mismo NIT (select head + await).
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ count: opts.sameTaxId ?? 0, data: null, error: null }),
        maybeSingle: () =>
          Promise.resolve({
            data: table === 'profiles' ? profile : null,
            error: null,
          }),
        insert: (values: Record<string, unknown>) => {
          if (table === 'audit_logs') audits.push(values);
          return Promise.resolve({ error: null });
        },
      });
      return b;
    },
    auth: {
      admin: {
        getUserById: jest.fn(() =>
          Promise.resolve({
            data: {
              user: {
                id: CLIENT,
                email_confirmed_at:
                  opts.emailConfirmed === false ? null : '2026-09-28T10:00:00Z',
              },
            },
            error: null,
          }),
        ),
      },
    },
    rpc: jest.fn(() =>
      Promise.resolve({
        data: opts.staffMember ? [{ role: 'staff', is_active: true }] : [],
        error: null,
      }),
    ),
  };

  const onboardingService = {
    uploadDocument: jest.fn(() => Promise.resolve({ id: 'doc-1' })),
    deleteDraftDocument: jest.fn(() => Promise.resolve({ deleted: true })),
    listDocuments: jest.fn(() => Promise.resolve([])),
    getDocumentSignedUrl: jest.fn(() =>
      Promise.resolve({ signed_url: 'x', expires_in: 3600 }),
    ),
  };
  const draftService = {
    getDraft: jest.fn(() => Promise.resolve(null as unknown)),
    saveDraft: jest.fn(() =>
      Promise.resolve({ updated_at: 'now', unchanged: false }),
    ),
    markReadyForClient: jest.fn(() =>
      Promise.resolve({ assisted_ready_at: 'now', progress_pct: 80 }),
    ),
  };
  const notifications = { sendNotification: jest.fn(() => Promise.resolve()) };
  const email = {
    sendAssistedOnboardingReadyEmail: jest.fn(() => Promise.resolve(true)),
  };

  const service = new StaffOnboardingAssistService(
    supabase as never,
    onboardingService as never,
    draftService as never,
    notifications as never,
    email as never,
  );

  return {
    service,
    audits,
    onboardingService,
    draftService,
    notifications,
    email,
  };
}

const dto = {
  type: 'company',
  step: 2,
  data: { legal_name: 'Empresa S.R.L.' },
  missing_fields: [],
  progress_pct: 20,
} as unknown as SaveOnboardingDraftDto;

describe('StaffOnboardingAssistService — a quién se puede asistir', () => {
  it('rechaza un usuario inexistente', async () => {
    const { service } = setup({ profile: null });
    await expect(service.saveDraft(actor, CLIENT, dto)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rechaza una cuenta ya aprobada', async () => {
    const { service, draftService } = setup({
      profile: clientProfile({ onboarding_status: 'approved' }),
    });
    await expect(service.saveDraft(actor, CLIENT, dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(draftService.saveDraft).not.toHaveBeenCalled();
  });

  it('rechaza una cuenta congelada o inactiva', async () => {
    const frozen = setup({ profile: clientProfile({ is_frozen: true }) });
    await expect(
      frozen.service.saveDraft(actor, CLIENT, dto),
    ).rejects.toBeInstanceOf(BadRequestException);
    const inactive = setup({ profile: clientProfile({ is_active: false }) });
    await expect(
      inactive.service.saveDraft(actor, CLIENT, dto),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza cuentas del personal interno', async () => {
    const { service, onboardingService } = setup({ staffMember: true });
    await expect(
      service.uploadDocument(actor, CLIENT, {} as Express.Multer.File, {
        document_type: 'national_id',
        subject_type: 'person',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(onboardingService.uploadDocument).not.toHaveBeenCalled();
  });
});

describe('StaffOnboardingAssistService — borrador y documentos', () => {
  it('guarda el borrador del cliente marcando al staff como asistente', async () => {
    const { service, draftService } = setup();
    await service.saveDraft(actor, CLIENT, dto);
    expect(draftService.saveDraft).toHaveBeenCalledWith(CLIENT, dto, {
      assistedBy: actor.id,
    });
  });

  it('audita el inicio sin copiar el contenido del formulario', async () => {
    const { service, audits } = setup();
    await service.saveDraft(actor, CLIENT, dto);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      performed_by: actor.id,
      action: 'STAFF_ASSIST_DRAFT_SAVE',
      record_id: CLIENT,
    });
    expect(JSON.stringify(audits[0])).not.toContain('Empresa S.R.L.');
  });

  it('no audita cada autosave del mismo paso', async () => {
    const { service, audits, draftService } = setup();
    draftService.getDraft.mockResolvedValue({ step: 2, type: 'company' });
    await service.saveDraft(actor, CLIENT, dto);
    expect(audits).toHaveLength(0);
  });

  it('sube documentos al cliente registrando quién los subió', async () => {
    const { service, onboardingService, audits } = setup();
    const file = { originalname: 'ci.jpg' } as Express.Multer.File;
    await service.uploadDocument(actor, CLIENT, file, {
      document_type: 'national_id',
      subject_type: 'person',
    });
    expect(onboardingService.uploadDocument).toHaveBeenCalledWith(
      CLIENT,
      file,
      'national_id',
      'person',
      undefined,
      undefined,
      actor.id,
    );
    expect(audits[0]).toMatchObject({ action: 'STAFF_ASSIST_DOC_UPLOAD' });
  });
});

describe('StaffOnboardingAssistService — listo para el cliente', () => {
  it('marca el borrador, notifica y envía el correo al cliente', async () => {
    const { service, draftService, notifications, email, audits } = setup();
    const result = await service.markReady(actor, CLIENT);

    expect(draftService.markReadyForClient).toHaveBeenCalledWith(
      CLIENT,
      actor.id,
    );
    expect(notifications.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: CLIENT, link: '/onboarding' }),
    );
    expect(email.sendAssistedOnboardingReadyEmail).toHaveBeenCalledWith({
      email: 'cliente@empresa.com',
      name: 'María',
    });
    expect(result.email_sent).toBe(true);
    expect(audits[0]).toMatchObject({
      action: 'STAFF_ASSIST_READY',
      record_id: CLIENT,
    });
  });
});

describe('StaffOnboardingAssistService — controles agregados en la auditoría', () => {
  it('no asiste una cuenta cuyo correo no fue verificado', async () => {
    const { service, draftService, email } = setup({ emailConfirmed: false });
    await expect(service.saveDraft(actor, CLIENT, dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.markReady(actor, CLIENT)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(draftService.saveDraft).not.toHaveBeenCalled();
    expect(email.sendAssistedOnboardingReadyEmail).not.toHaveBeenCalled();
  });

  it('informa al staff cuántas otras cuentas declararon el mismo NIT', async () => {
    const { service } = setup({ sameTaxId: 2 });
    const ctx = await service.getContext(CLIENT);
    expect(ctx.same_tax_id_accounts).toBe(2);
    expect(ctx.client.tax_id).toBe('1020304025');
  });

  it('sin NIT declarado no busca duplicados', async () => {
    const { service } = setup({
      profile: clientProfile({ tax_id: null }),
      sameTaxId: 5,
    });
    const ctx = await service.getContext(CLIENT);
    expect(ctx.same_tax_id_accounts).toBe(0);
  });

  it('audita cada vez que el staff abre un documento del cliente', async () => {
    const { service, audits, onboardingService } = setup();
    await service.getDocumentSignedUrl(actor, CLIENT, 'doc-9');
    expect(onboardingService.getDocumentSignedUrl).toHaveBeenCalledWith(
      CLIENT,
      'doc-9',
    );
    expect(audits[0]).toMatchObject({
      action: 'STAFF_ASSIST_DOC_VIEW',
      performed_by: actor.id,
      record_id: CLIENT,
    });
  });
});

describe('StaffOnboardingAssistService — tipo de cuenta', () => {
  it('expone al staff el tipo que el cliente declaró al registrarse', async () => {
    const { service } = setup();
    expect((await service.getContext(CLIENT)).client.account_type).toBe('company');
  });

  it('cuentas antiguas sin tipo llegan como null (el staff elige KYC/KYB)', async () => {
    const { service } = setup({ profile: clientProfile({ account_type: null }) });
    expect((await service.getContext(CLIENT)).client.account_type).toBeNull();
  });
});
