-- Estado de cumplimiento de cada beneficiario. NULL para todos los existentes:
-- solo 'blocked' impide pagar (SuppliersService.assertUsableForPayment).
-- DEBE aplicarse antes de desplegar el backend que la consulta: los SELECT de
-- payment-orders.service piden compliance_status y fallarian sin la columna.
-- Aplicada en staging como 20260916203611_suppliers_compliance_status.
alter table public.suppliers
  add column if not exists compliance_status text,
  add column if not exists compliance_reason text,
  add column if not exists compliance_updated_at timestamptz;

comment on column public.suppliers.compliance_status is
  'NULL | pending_review | blocked — resultado del screening AML de la dirección. Solo blocked impide pagar.';
comment on column public.suppliers.compliance_reason is
  'Motivo legible del estado, para el panel de compliance y el audit trail.';
comment on column public.suppliers.compliance_updated_at is
  'Cuándo se fijó el estado actual.';

alter table public.suppliers
  drop constraint if exists suppliers_compliance_status_check;
alter table public.suppliers
  add constraint suppliers_compliance_status_check
  check (compliance_status is null or compliance_status in ('pending_review', 'blocked'));

create index if not exists idx_suppliers_compliance_status
  on public.suppliers (compliance_status)
  where compliance_status is not null;
