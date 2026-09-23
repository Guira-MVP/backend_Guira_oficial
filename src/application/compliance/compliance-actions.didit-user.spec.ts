import { NotFoundException } from '@nestjs/common';
import { ComplianceActionsService } from './compliance-actions.service';

/**
 * Pre-verificación con Didit lanzada desde el detalle de usuario
 * (POST /admin/compliance/users/:userId/verify-didit): resuelve el
 * expediente más reciente del usuario sin exigir un review abierto.
 */

function applicationBuilder(row: Record<string, unknown> | null) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  };
  return builder;
}

function buildService(opts: {
  kyc?: Record<string, unknown> | null;
  kyb?: Record<string, unknown> | null;
  reviewId?: string | null;
}) {
  const supabase = {
    from: jest.fn((table: string) => {
      if (table === 'kyc_applications')
        return applicationBuilder(opts.kyc ?? null);
      if (table === 'kyb_applications')
        return applicationBuilder(opts.kyb ?? null);
      throw new Error(`tabla no configurada: ${table}`);
    }),
  };
  const didit = {
    runForApplication: jest.fn().mockResolvedValue({
      verdict: { overall: 'approved' },
      reused: false,
      reviewId: opts.reviewId ?? null,
    }),
  };
  const gateway = { emitComplianceReviewUpdated: jest.fn() };
  const service = new ComplianceActionsService(
    supabase as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    gateway as never,
    didit as never,
  );
  return { service, didit, gateway };
}

describe('ComplianceActionsService.verifyUserWithDidit', () => {
  it('404 si el usuario no tiene expediente de onboarding', async () => {
    const { service, didit } = buildService({});

    await expect(
      service.verifyUserWithDidit('user-1', 'actor-1', 'staff'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(didit.runForApplication).not.toHaveBeenCalled();
  });

  it('verifica el KYB cuando es el único expediente', async () => {
    const { service, didit } = buildService({
      kyb: { id: 'kyb-1', created_at: '2026-05-01T00:00:00Z' },
    });

    await service.verifyUserWithDidit('user-1', 'actor-1', 'admin', true);

    expect(didit.runForApplication).toHaveBeenCalledWith(
      'kyb',
      'kyb-1',
      'actor-1',
      'admin',
      true,
    );
  });

  it('con KYC y KYB elige el más reciente', async () => {
    const { service, didit } = buildService({
      kyc: { id: 'kyc-1', created_at: '2026-01-01T00:00:00Z' },
      kyb: { id: 'kyb-1', created_at: '2026-03-01T00:00:00Z' },
    });

    await service.verifyUserWithDidit('user-1', 'actor-1', 'staff');

    expect(didit.runForApplication).toHaveBeenCalledWith(
      'kyb',
      'kyb-1',
      'actor-1',
      'staff',
      false,
    );
  });

  it('avisa al panel solo si el expediente tiene review, y no expone reviewId', async () => {
    const withReview = buildService({
      kyc: { id: 'kyc-1', created_at: '2026-01-01T00:00:00Z' },
      reviewId: 'review-1',
    });
    const result = await withReview.service.verifyUserWithDidit(
      'user-1',
      'actor-1',
      'staff',
    );
    expect(withReview.gateway.emitComplianceReviewUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'review-1' }),
    );
    expect(result).toEqual({ verdict: { overall: 'approved' }, reused: false });

    const withoutReview = buildService({
      kyc: { id: 'kyc-1', created_at: '2026-01-01T00:00:00Z' },
    });
    await withoutReview.service.verifyUserWithDidit(
      'user-1',
      'actor-1',
      'staff',
    );
    expect(
      withoutReview.gateway.emitComplianceReviewUpdated,
    ).not.toHaveBeenCalled();
  });
});
