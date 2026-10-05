-- Collection Account tipo wallet de Tazapay por cliente (fondeo interno).
--
-- Tazapay no tiene wallet por cliente: todo lo cobrado entra al balance único
-- de la cuenta Guira y los payouts salen de ese balance. Para pagar por SWIFT
-- se fondea Tazapay con el dinero de cada cliente a través de una wallet
-- (USDC/Solana) creada on_behalf_of su entity. Uso interno: el cliente nunca
-- la ve. Los depósitos se registran en tazapay_collects y se concilian con las
-- órdenes en la entrega de los flujos SWIFT.
--
-- No se usa public.wallets: su índice (user_id, network) choca con la wallet
-- Bridge del cliente en solana, y esa tabla alimenta la UI del cliente.
--
-- Solo service_role: RLS sin policies y REVOKE explícito a anon/authenticated
-- (REVOKE FROM PUBLIC no alcanza en Supabase).

create table if not exists public.tazapay_collection_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  entity_id text not null,
  collection_account_id text unique,
  enable_request_id text,
  payment_method_type text not null default 'stablecoin_usdc',
  chain text not null default 'solana',
  deposit_address text,
  account_status text not null default 'pending'
    check (account_status in ('pending', 'disabled', 'enabled')),
  request_status text not null default 'pending'
    check (request_status in (
      'pending', 'processing', 'requires_action', 'approval_hold',
      'succeeded', 'failed', 'cancelled'
    )),
  failure_code text,
  failure_reason text,
  transfer_limit_min numeric,
  transfer_limit_max numeric,
  limit_currency text,
  restricted_remitter_countries text[],
  setup_time text,
  fee_details jsonb,
  balance_transaction text,
  idempotency_key text not null,
  raw_last_response jsonb,
  attempt_count integer not null default 0,
  last_checked_at timestamptz,
  enabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tazapay_collection_accounts_one_per_user
    unique (user_id, payment_method_type, chain)
);

comment on table public.tazapay_collection_accounts is
  'Wallet de fondeo (collection account tipo wallet) de Tazapay por cliente, on_behalf_of su entity. Uso interno: no se muestra al cliente.';

create index if not exists idx_tazapay_collection_accounts_pending
  on public.tazapay_collection_accounts (request_status)
  where request_status in ('pending', 'processing', 'requires_action', 'approval_hold');

create table if not exists public.tazapay_collects (
  id uuid primary key default gen_random_uuid(),
  collect_id text not null unique,
  collection_account_id text,
  user_id uuid references public.profiles(id) on delete restrict,
  entity_id text,
  status text not null
    check (status in ('detected', 'succeeded', 'failed', 'on_hold', 'reversed', 'unknown')),
  -- Monto tal como lo envía Tazapay (unidad mínima de la moneda, p. ej. centavos).
  amount numeric,
  currency text,
  payment_method_type text,
  holding_currency text,
  balance_transaction text,
  payer_wallet text,
  payer_network text,
  tx_hash text,
  payment_order_id uuid references public.payment_orders(id) on delete set null,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.tazapay_collects is
  'Depósitos (collect.*) recibidos en las wallets de fondeo de Tazapay. Se concilian con payment_orders en los flujos SWIFT.';

create index if not exists idx_tazapay_collects_user on public.tazapay_collects (user_id);
create index if not exists idx_tazapay_collects_account on public.tazapay_collects (collection_account_id);

alter table public.tazapay_collection_accounts enable row level security;
alter table public.tazapay_collects enable row level security;

revoke all on table public.tazapay_collection_accounts from public, anon, authenticated;
revoke all on table public.tazapay_collects from public, anon, authenticated;
grant all on table public.tazapay_collection_accounts to service_role;
grant all on table public.tazapay_collects to service_role;

-- Interruptor: crear la wallet automáticamente al aprobarse la entity.
-- Apagado por defecto: cada wallet cobra alta al balance de Guira, puede tener
-- mantenimiento y no se puede deshabilitar.
insert into public.app_settings (key, value, type, description, is_public)
values (
  'TAZAPAY_COLLECTION_WALLET_ENABLED',
  'false',
  'boolean',
  'Crear automáticamente la wallet de fondeo de Tazapay (USDC/Solana) al aprobarse la entity del cliente',
  false
)
on conflict (key) do nothing;
