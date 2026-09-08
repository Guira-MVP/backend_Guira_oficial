-- ═══════════════════════════════════════════════════════════════════
--  Trazabilidad de cancelación de expedientes
--
--  Hasta ahora una orden cancelada solo dejaba status='cancelled': no se
--  sabía quién la canceló (cliente o staff), cuándo, ni con qué motivo.
--  Para reportar y auditar cancelaciones había que cruzar contra audit_logs
--  en cada consulta.
--
--  Estas cuatro columnas se escriben SIEMPRE en el mismo UPDATE que pone
--  status='cancelled' (compare-and-set), nunca en un paso aparte:
--    - cancelled_at        → timestamp del cierre
--    - cancelled_by        → profiles.id del actor (dueño de la orden o staff)
--    - cancelled_by_role   → 'client' | 'staff' (el rol fino va en audit_logs.role)
--    - cancellation_reason → declaración del cliente o motivo obligatorio del staff
--
--  Migración puramente ADITIVA: no toca payment_orders_status_check
--  ('cancelled' ya es un valor válido) ni ninguna fila existente.
-- ═══════════════════════════════════════════════════════════════════

alter table public.payment_orders
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references public.profiles(id),
  add column if not exists cancelled_by_role text,
  add column if not exists cancellation_reason text;

--  Solo 'client' | 'staff'. El rol granular (staff/admin/super_admin) se
--  registra en audit_logs.role, igual que hace approveOrder con approved_by.
alter table public.payment_orders
  drop constraint if exists payment_orders_cancelled_by_role_check;

alter table public.payment_orders
  add constraint payment_orders_cancelled_by_role_check
  check (cancelled_by_role is null or cancelled_by_role = any (array['client'::text, 'staff'::text]));

--  Índice parcial: los reportes de cancelación filtran siempre por
--  status='cancelled' y ordenan por fecha descendente.
create index if not exists idx_payment_orders_cancelled
  on public.payment_orders (cancelled_at desc)
  where status = 'cancelled';

comment on column public.payment_orders.cancelled_at is
  'Momento de la cancelación. Se escribe en el mismo UPDATE que status=cancelled.';
comment on column public.payment_orders.cancelled_by is
  'Actor que canceló: el propio usuario (cancelación de cliente) o el staff/admin (cancelación operativa).';
comment on column public.payment_orders.cancelled_by_role is
  'client | staff. Distingue el origen de la cancelación sin joins contra audit_logs.';
comment on column public.payment_orders.cancellation_reason is
  'Motivo. En cliente incluye la declaración de no-depósito (flujos fiat BO); en staff es obligatorio.';
