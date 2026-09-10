-- ============================================================================
-- Migration: baseline schema for tables missing from migration history
-- Date: 2026-08-13
--
-- Contexto: al crear una rama de Supabase (staging) para el entorno de
-- pruebas, la reproducción de migraciones falló porque 28 de las 55 tablas
-- de producción nunca fueron creadas por una migración registrada (se
-- crearon en algún momento vía dashboard/SQL suelto). Esta migración es
-- idempotente respecto a producción (usa IF NOT EXISTS / ON CONFLICT DO
-- NOTHING donde aplica) — en producción no cambia nada, solo deja el
-- historial de migraciones completo para que cualquier reproducción futura
-- (branching, disaster recovery, ambientes nuevos) funcione sin parches.
--
-- Todo el DDL fue extraído directamente del catálogo de Postgres de
-- producción (information_schema / pg_catalog) el 2026-08-13, columna por
-- columna, constraint por constraint, para que coincida exactamente con el
-- estado real.
--
-- NOTA: en supabase_migrations.schema_migrations el version de esta
-- migración se reasignó manualmente a 20260123214251 (justo después de
-- 20260123214250_elite_security_and_auditing_v2, que crea `documents`, y
-- antes de 20260523141549, la primera migración que ya asumía que
-- `businesses` existía) para que el reemplazo de migraciones (branching)
-- la aplique en el orden correcto. El nombre de archivo mantiene la fecha
-- real de creación (2026-08-13) por trazabilidad histórica.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. CREATE TABLE (solo columnas — constraints se agregan en la sección 2
--    para evitar problemas de orden de dependencias entre estas tablas)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.auth_audit_log (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  event_type text NOT NULL,
  user_id uuid,
  email text,
  ip_address text,
  user_agent text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.balances (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  currency text NOT NULL,
  amount numeric DEFAULT 0,
  pending_amount numeric DEFAULT 0,
  reserved_amount numeric DEFAULT 0,
  available_amount numeric DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bridge_kyc_links (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  kyc_application_id uuid,
  bridge_kyc_link_id text,
  link_url text,
  type text,
  status text DEFAULT 'pending'::text,
  bridge_customer_id text,
  expires_at timestamp with time zone,
  completed_at timestamp with time zone,
  approved_at timestamp with time zone,
  rejection_reason text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bridge_liquidation_addresses (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  bridge_liquidation_address_id text,
  bridge_customer_id text,
  chain text,
  currency text,
  address text,
  destination_payment_rail text,
  destination_currency text,
  destination_external_account_id text,
  developer_fee_percent numeric,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  destination_address text,
  destination_ach_reference text,
  destination_wire_message text,
  destination_sepa_reference text,
  destination_spei_reference text,
  destination_reference text
);

CREATE TABLE IF NOT EXISTS public.bridge_pull_jobs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  initiated_by uuid,
  job_type text,
  target_user_id uuid,
  date_range_from timestamp with time zone,
  date_range_to timestamp with time zone,
  status text DEFAULT 'pending'::text,
  records_checked integer DEFAULT 0,
  gaps_found integer DEFAULT 0,
  gaps_detail jsonb,
  actions_taken jsonb,
  error_message text,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.business_directors (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid NOT NULL,
  first_name text,
  last_name text,
  "position" text,
  is_signer boolean DEFAULT false,
  date_of_birth date,
  nationality text,
  country_of_residence text,
  id_type text,
  id_number text,
  id_expiry_date date,
  email text,
  phone text,
  address1 text,
  city text,
  country text,
  document_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  has_control boolean DEFAULT true NOT NULL,
  is_pep boolean DEFAULT false NOT NULL,
  attested_ownership_structure_at timestamp with time zone,
  state text,
  bridge_associated_person_id text
);

CREATE TABLE IF NOT EXISTS public.business_ubos (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid NOT NULL,
  first_name text,
  last_name text,
  date_of_birth date,
  nationality text,
  country_of_residence text,
  ownership_percent numeric,
  id_type text,
  id_number text,
  id_expiry_date date,
  tax_id text,
  email text,
  phone text,
  address1 text,
  address2 text,
  city text,
  state text,
  postal_code text,
  country text,
  is_pep boolean DEFAULT false,
  document_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  has_control boolean DEFAULT false NOT NULL,
  is_signer boolean DEFAULT false NOT NULL,
  "position" text,
  bridge_associated_person_id text,
  director_id uuid,
  is_director boolean DEFAULT false NOT NULL
);

CREATE TABLE IF NOT EXISTS public.businesses (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  legal_name text,
  trade_name text,
  registration_number text,
  tax_id text,
  entity_type text,
  incorporation_date date,
  country_of_incorporation text,
  state_of_incorporation text,
  operating_countries text[],
  website text,
  email text,
  phone text,
  address1 text,
  address2 text,
  city text,
  state text,
  postal_code text,
  country text,
  business_description text,
  business_industry text,
  account_purpose text,
  source_of_funds text,
  conducts_money_services boolean DEFAULT false,
  uses_bridge_for_money_services boolean DEFAULT false,
  compliance_explanation text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  estimated_annual_revenue_usd text,
  high_risk_activities text[],
  physical_address1 text,
  physical_address2 text,
  physical_city text,
  physical_state text,
  physical_postal_code text,
  physical_country text,
  expected_monthly_payments_usd text,
  acting_as_intermediary boolean DEFAULT false,
  operates_in_prohibited_countries boolean DEFAULT false,
  source_of_funds_description text,
  high_risk_activities_explanation text,
  account_purpose_other text,
  is_dao boolean DEFAULT false,
  conducts_money_services_description text,
  other_websites text[],
  customer_types_served text,
  has_foreign_tax_registration boolean,
  ownership_threshold integer DEFAULT 25,
  has_material_intermediary_ownership boolean
);

CREATE TABLE IF NOT EXISTS public.certificates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid,
  subject_type text,
  subject_id uuid,
  certificate_number text,
  pdf_storage_path text,
  content_hash text,
  amount numeric,
  currency text,
  issued_at timestamp with time zone DEFAULT now(),
  metadata jsonb,
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.client_bank_accounts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  bank_name text NOT NULL,
  account_number text NOT NULL,
  account_holder text NOT NULL,
  currency text DEFAULT 'BOB'::text NOT NULL,
  country text DEFAULT 'BO'::text NOT NULL,
  account_type text DEFAULT 'savings'::text,
  is_primary boolean DEFAULT true,
  is_verified boolean DEFAULT false,
  status text DEFAULT 'approved'::text NOT NULL,
  pending_changes jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  change_reason text,
  last_change_requested_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.compliance_review_comments (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  review_id uuid NOT NULL,
  author_id uuid,
  body text,
  is_internal boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.compliance_review_events (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  review_id uuid NOT NULL,
  actor_id uuid,
  decision text,
  reason text,
  metadata jsonb,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.compliance_reviews (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  subject_type text,
  subject_id uuid,
  assigned_to uuid,
  status text DEFAULT 'open'::text,
  priority text DEFAULT 'normal'::text,
  due_date date,
  opened_at timestamp with time zone DEFAULT now(),
  closed_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.currency_settings (
  currency text NOT NULL,
  label text NOT NULL,
  currency_type text DEFAULT 'crypto'::text NOT NULL,
  is_active boolean DEFAULT false NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  updated_at timestamp with time zone DEFAULT now(),
  updated_by uuid,
  is_active_va boolean DEFAULT false NOT NULL,
  is_active_supplier boolean DEFAULT false NOT NULL
);

CREATE TABLE IF NOT EXISTS public.customer_fee_overrides (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  operation_type text,
  payment_rail text,
  currency text,
  fee_type text,
  fee_percent numeric,
  fee_fixed numeric,
  min_fee numeric,
  max_fee numeric,
  is_active boolean DEFAULT true,
  valid_from date DEFAULT CURRENT_DATE,
  valid_until date,
  notes text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.customer_limit_overrides (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  flow_type text NOT NULL,
  min_usd numeric(18,2),
  max_usd numeric(18,2),
  is_active boolean DEFAULT true NOT NULL,
  valid_from date DEFAULT CURRENT_DATE NOT NULL,
  valid_until date,
  notes text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.exchange_rates_config (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  pair text NOT NULL,
  rate numeric(12,6) NOT NULL,
  spread_percent numeric(5,2) DEFAULT 0,
  updated_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  bridge_buy_rate numeric,
  bridge_sell_rate numeric
);

CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  endpoint text NOT NULL,
  response_status integer DEFAULT 201 NOT NULL,
  response_body jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone DEFAULT (now() + '24:00:00'::interval) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.kyb_applications (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid NOT NULL,
  requester_user_id uuid NOT NULL,
  status text DEFAULT 'pending'::text,
  provider text,
  provider_id text,
  screening jsonb,
  last_screened_at timestamp with time zone,
  tos_accepted_at timestamp with time zone,
  tos_contract_id text,
  source text,
  observations text,
  directors_complete boolean DEFAULT false,
  ubos_complete boolean DEFAULT false,
  documents_complete boolean DEFAULT false,
  submitted_at timestamp with time zone,
  approved_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  field_observations jsonb DEFAULT '{}'::jsonb NOT NULL,
  previous_data jsonb
);

CREATE TABLE IF NOT EXISTS public.kyc_applications (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  person_id uuid,
  status text DEFAULT 'pending'::text,
  provider text,
  provider_id text,
  screening jsonb,
  last_screened_at timestamp with time zone,
  tos_accepted_at timestamp with time zone,
  tos_contract_id text,
  source text,
  observations text,
  submitted_at timestamp with time zone,
  approved_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  field_observations jsonb DEFAULT '{}'::jsonb NOT NULL,
  previous_data jsonb,
  bridge_request_payload jsonb
);

CREATE TABLE IF NOT EXISTS public.people (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  first_name text,
  last_name text,
  date_of_birth date,
  nationality text,
  country_of_residence text,
  tax_id text,
  id_type text,
  id_number text,
  id_expiry_date date,
  email text,
  phone text,
  address1 text,
  address2 text,
  city text,
  state text,
  postal_code text,
  country text,
  source_of_funds text,
  account_purpose text,
  is_pep boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  employment_status text,
  expected_monthly_payments_usd text,
  most_recent_occupation text,
  middle_name text,
  account_purpose_other text,
  acting_as_intermediary boolean,
  tax_id_type text
);

CREATE TABLE IF NOT EXISTS public.reconciliation_runs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  initiated_by uuid,
  run_type text,
  status text DEFAULT 'running'::text,
  users_checked integer DEFAULT 0,
  currencies_checked text[],
  discrepancies_found integer DEFAULT 0,
  discrepancies_detail jsonb,
  auto_corrected boolean DEFAULT false,
  auto_corrections_detail jsonb,
  requires_manual_review boolean DEFAULT false,
  error_message text,
  started_at timestamp with time zone DEFAULT now(),
  completed_at timestamp with time zone,
  duration_ms integer,
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.rejection_templates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  category text NOT NULL,
  label text NOT NULL,
  body text NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.transaction_limits (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  tier text,
  daily_deposit_limit numeric,
  daily_payout_limit numeric,
  weekly_deposit_limit numeric,
  weekly_payout_limit numeric,
  monthly_deposit_limit numeric,
  monthly_payout_limit numeric,
  single_txn_limit numeric,
  single_txn_above_review numeric,
  applied_by uuid,
  reason text,
  effective_from timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.va_fee_defaults (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  source_currency text NOT NULL,
  destination_type text NOT NULL,
  fee_percent numeric DEFAULT 0 NOT NULL,
  updated_by uuid,
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.va_fee_overrides (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  source_currency text NOT NULL,
  destination_type text NOT NULL,
  fee_percent numeric NOT NULL,
  reason text,
  set_by uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.va_source_currency_settings (
  currency text NOT NULL,
  label text NOT NULL,
  rail_label text NOT NULL,
  flag_iso text NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  updated_at timestamp with time zone DEFAULT now(),
  updated_by uuid,
  is_active_supplier boolean DEFAULT true NOT NULL
);

CREATE TABLE IF NOT EXISTS public.webhook_events (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  provider text DEFAULT 'bridge'::text,
  event_type text,
  provider_event_id text,
  raw_payload jsonb,
  headers jsonb,
  signature_verified boolean DEFAULT false,
  status text DEFAULT 'pending'::text,
  retry_count integer DEFAULT 0,
  last_error text,
  bridge_api_version text,
  received_at timestamp with time zone DEFAULT now(),
  processing_started_at timestamp with time zone,
  processed_at timestamp with time zone
);

-- ----------------------------------------------------------------------------
-- 2. Constraints (PK / UNIQUE / CHECK primero, FK al final para no depender
--    del orden de creación entre estas 28 tablas)
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  -- PRIMARY KEY
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_audit_log_pkey') THEN ALTER TABLE public.auth_audit_log ADD CONSTRAINT auth_audit_log_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'balances_pkey') THEN ALTER TABLE public.balances ADD CONSTRAINT balances_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bridge_kyc_links_pkey') THEN ALTER TABLE public.bridge_kyc_links ADD CONSTRAINT bridge_kyc_links_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bridge_liquidation_addresses_pkey') THEN ALTER TABLE public.bridge_liquidation_addresses ADD CONSTRAINT bridge_liquidation_addresses_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bridge_pull_jobs_pkey') THEN ALTER TABLE public.bridge_pull_jobs ADD CONSTRAINT bridge_pull_jobs_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_directors_pkey') THEN ALTER TABLE public.business_directors ADD CONSTRAINT business_directors_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_ubos_pkey') THEN ALTER TABLE public.business_ubos ADD CONSTRAINT business_ubos_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'businesses_pkey') THEN ALTER TABLE public.businesses ADD CONSTRAINT businesses_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'certificates_pkey') THEN ALTER TABLE public.certificates ADD CONSTRAINT certificates_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_bank_accounts_pkey') THEN ALTER TABLE public.client_bank_accounts ADD CONSTRAINT client_bank_accounts_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compliance_review_comments_pkey') THEN ALTER TABLE public.compliance_review_comments ADD CONSTRAINT compliance_review_comments_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compliance_review_events_pkey') THEN ALTER TABLE public.compliance_review_events ADD CONSTRAINT compliance_review_events_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compliance_reviews_pkey') THEN ALTER TABLE public.compliance_reviews ADD CONSTRAINT compliance_reviews_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'currency_settings_pkey') THEN ALTER TABLE public.currency_settings ADD CONSTRAINT currency_settings_pkey PRIMARY KEY (currency); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_fee_overrides_pkey') THEN ALTER TABLE public.customer_fee_overrides ADD CONSTRAINT customer_fee_overrides_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_limit_overrides_pkey') THEN ALTER TABLE public.customer_limit_overrides ADD CONSTRAINT customer_limit_overrides_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exchange_rates_config_pkey') THEN ALTER TABLE public.exchange_rates_config ADD CONSTRAINT exchange_rates_config_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'idempotency_keys_pkey') THEN ALTER TABLE public.idempotency_keys ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kyb_applications_pkey') THEN ALTER TABLE public.kyb_applications ADD CONSTRAINT kyb_applications_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kyc_applications_pkey') THEN ALTER TABLE public.kyc_applications ADD CONSTRAINT kyc_applications_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'people_pkey') THEN ALTER TABLE public.people ADD CONSTRAINT people_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reconciliation_runs_pkey') THEN ALTER TABLE public.reconciliation_runs ADD CONSTRAINT reconciliation_runs_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rejection_templates_pkey') THEN ALTER TABLE public.rejection_templates ADD CONSTRAINT rejection_templates_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transaction_limits_pkey') THEN ALTER TABLE public.transaction_limits ADD CONSTRAINT transaction_limits_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'va_fee_defaults_pkey') THEN ALTER TABLE public.va_fee_defaults ADD CONSTRAINT va_fee_defaults_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'va_fee_overrides_pkey') THEN ALTER TABLE public.va_fee_overrides ADD CONSTRAINT va_fee_overrides_pkey PRIMARY KEY (id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'va_source_currency_settings_pkey') THEN ALTER TABLE public.va_source_currency_settings ADD CONSTRAINT va_source_currency_settings_pkey PRIMARY KEY (currency); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_events_pkey') THEN ALTER TABLE public.webhook_events ADD CONSTRAINT webhook_events_pkey PRIMARY KEY (id); END IF;

  -- UNIQUE
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'balances_user_currency_key') THEN ALTER TABLE public.balances ADD CONSTRAINT balances_user_currency_key UNIQUE (user_id, currency); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'certificates_certificate_number_key') THEN ALTER TABLE public.certificates ADD CONSTRAINT certificates_certificate_number_key UNIQUE (certificate_number); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exchange_rates_config_pair_key') THEN ALTER TABLE public.exchange_rates_config ADD CONSTRAINT exchange_rates_config_pair_key UNIQUE (pair); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'idempotency_keys_user_key_unique') THEN ALTER TABLE public.idempotency_keys ADD CONSTRAINT idempotency_keys_user_key_unique UNIQUE (user_id, idempotency_key); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'va_fee_defaults_source_currency_destination_type_key') THEN ALTER TABLE public.va_fee_defaults ADD CONSTRAINT va_fee_defaults_source_currency_destination_type_key UNIQUE (source_currency, destination_type); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'va_fee_overrides_user_id_source_currency_destination_type_key') THEN ALTER TABLE public.va_fee_overrides ADD CONSTRAINT va_fee_overrides_user_id_source_currency_destination_type_key UNIQUE (user_id, source_currency, destination_type); END IF;

  -- CHECK
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'balances_available_amount_nonnegative') THEN ALTER TABLE public.balances ADD CONSTRAINT balances_available_amount_nonnegative CHECK ((available_amount >= (0)::numeric)); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'balances_reserved_amount_nonnegative') THEN ALTER TABLE public.balances ADD CONSTRAINT balances_reserved_amount_nonnegative CHECK ((reserved_amount >= (0)::numeric)); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bridge_kyc_links_status_check') THEN ALTER TABLE public.bridge_kyc_links ADD CONSTRAINT bridge_kyc_links_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'completed'::text, 'expired'::text, 'rejected'::text]))); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bridge_pull_jobs_status_check') THEN ALTER TABLE public.bridge_pull_jobs ADD CONSTRAINT bridge_pull_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text]))); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'businesses_ownership_threshold_check') THEN ALTER TABLE public.businesses ADD CONSTRAINT businesses_ownership_threshold_check CHECK (((ownership_threshold IS NULL) OR ((ownership_threshold >= 5) AND (ownership_threshold <= 25)))); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'businesses_customer_types_served_check') THEN ALTER TABLE public.businesses ADD CONSTRAINT businesses_customer_types_served_check CHECK (((customer_types_served IS NULL) OR (customer_types_served = ANY (ARRAY['individuals'::text, 'businesses'::text, 'both'::text])))); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compliance_reviews_priority_check') THEN ALTER TABLE public.compliance_reviews ADD CONSTRAINT compliance_reviews_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text]))); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compliance_reviews_status_check') THEN ALTER TABLE public.compliance_reviews ADD CONSTRAINT compliance_reviews_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'closed'::text, 'escalated'::text]))); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_fee_overrides_fee_type_check') THEN ALTER TABLE public.customer_fee_overrides ADD CONSTRAINT customer_fee_overrides_fee_type_check CHECK ((fee_type = ANY (ARRAY['percent'::text, 'fixed'::text, 'mixed'::text]))); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kyb_applications_status_check') THEN ALTER TABLE public.kyb_applications ADD CONSTRAINT kyb_applications_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'submitted'::text, 'approved'::text, 'rejected'::text, 'needs_review'::text, 'sent_to_bridge'::text, 'bridge_rejected'::text]))); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kyc_applications_status_check') THEN ALTER TABLE public.kyc_applications ADD CONSTRAINT kyc_applications_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'submitted'::text, 'approved'::text, 'rejected'::text, 'needs_review'::text, 'sent_to_bridge'::text, 'bridge_rejected'::text]))); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reconciliation_runs_status_check') THEN ALTER TABLE public.reconciliation_runs ADD CONSTRAINT reconciliation_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text]))); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rejection_templates_category_check') THEN ALTER TABLE public.rejection_templates ADD CONSTRAINT rejection_templates_category_check CHECK ((category = ANY (ARRAY['in_review'::text, 'rejected'::text, 'approved'::text, 'failed'::text, 'quote'::text, 'sent'::text, 'completed'::text]))); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'va_fee_defaults_destination_type_check') THEN ALTER TABLE public.va_fee_defaults ADD CONSTRAINT va_fee_defaults_destination_type_check CHECK ((destination_type = ANY (ARRAY['wallet_bridge'::text, 'wallet_external'::text]))); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'va_fee_defaults_fee_percent_check') THEN ALTER TABLE public.va_fee_defaults ADD CONSTRAINT va_fee_defaults_fee_percent_check CHECK (((fee_percent >= (0)::numeric) AND (fee_percent <= (100)::numeric))); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'va_fee_overrides_destination_type_check') THEN ALTER TABLE public.va_fee_overrides ADD CONSTRAINT va_fee_overrides_destination_type_check CHECK ((destination_type = ANY (ARRAY['wallet_bridge'::text, 'wallet_external'::text]))); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'va_fee_overrides_fee_percent_check') THEN ALTER TABLE public.va_fee_overrides ADD CONSTRAINT va_fee_overrides_fee_percent_check CHECK (((fee_percent >= (0)::numeric) AND (fee_percent <= (100)::numeric))); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_events_status_check') THEN ALTER TABLE public.webhook_events ADD CONSTRAINT webhook_events_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'processed'::text, 'failed'::text, 'skipped'::text]))); END IF;

  -- FOREIGN KEY (después de que todas las PK/UNIQUE de las 28 tablas existen)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_audit_log_user_id_fkey') THEN ALTER TABLE public.auth_audit_log ADD CONSTRAINT auth_audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'balances_user_id_fkey') THEN ALTER TABLE public.balances ADD CONSTRAINT balances_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bridge_kyc_links_kyc_application_id_fkey') THEN ALTER TABLE public.bridge_kyc_links ADD CONSTRAINT bridge_kyc_links_kyc_application_id_fkey FOREIGN KEY (kyc_application_id) REFERENCES kyc_applications(id) ON DELETE SET NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bridge_kyc_links_user_id_fkey') THEN ALTER TABLE public.bridge_kyc_links ADD CONSTRAINT bridge_kyc_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bridge_liquidation_addresses_user_id_fkey') THEN ALTER TABLE public.bridge_liquidation_addresses ADD CONSTRAINT bridge_liquidation_addresses_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bridge_pull_jobs_initiated_by_fkey') THEN ALTER TABLE public.bridge_pull_jobs ADD CONSTRAINT bridge_pull_jobs_initiated_by_fkey FOREIGN KEY (initiated_by) REFERENCES profiles(id) ON DELETE SET NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bridge_pull_jobs_target_user_id_fkey') THEN ALTER TABLE public.bridge_pull_jobs ADD CONSTRAINT bridge_pull_jobs_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES profiles(id) ON DELETE SET NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_directors_document_id_fkey') THEN ALTER TABLE public.business_directors ADD CONSTRAINT business_directors_document_id_fkey FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_directors_business_id_fkey') THEN ALTER TABLE public.business_directors ADD CONSTRAINT business_directors_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_ubos_document_id_fkey') THEN ALTER TABLE public.business_ubos ADD CONSTRAINT business_ubos_document_id_fkey FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_ubos_director_id_fkey') THEN ALTER TABLE public.business_ubos ADD CONSTRAINT business_ubos_director_id_fkey FOREIGN KEY (director_id) REFERENCES business_directors(id) ON DELETE SET NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_ubos_business_id_fkey') THEN ALTER TABLE public.business_ubos ADD CONSTRAINT business_ubos_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'businesses_user_id_fkey') THEN ALTER TABLE public.businesses ADD CONSTRAINT businesses_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'certificates_user_id_fkey') THEN ALTER TABLE public.certificates ADD CONSTRAINT certificates_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_bank_accounts_user_id_fkey') THEN ALTER TABLE public.client_bank_accounts ADD CONSTRAINT client_bank_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compliance_review_comments_review_id_fkey') THEN ALTER TABLE public.compliance_review_comments ADD CONSTRAINT compliance_review_comments_review_id_fkey FOREIGN KEY (review_id) REFERENCES compliance_reviews(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compliance_review_comments_author_id_fkey') THEN ALTER TABLE public.compliance_review_comments ADD CONSTRAINT compliance_review_comments_author_id_fkey FOREIGN KEY (author_id) REFERENCES profiles(id) ON DELETE SET NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compliance_review_events_actor_id_fkey') THEN ALTER TABLE public.compliance_review_events ADD CONSTRAINT compliance_review_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES profiles(id) ON DELETE SET NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compliance_review_events_review_id_fkey') THEN ALTER TABLE public.compliance_review_events ADD CONSTRAINT compliance_review_events_review_id_fkey FOREIGN KEY (review_id) REFERENCES compliance_reviews(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compliance_reviews_assigned_to_fkey') THEN ALTER TABLE public.compliance_reviews ADD CONSTRAINT compliance_reviews_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES profiles(id) ON DELETE SET NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'currency_settings_updated_by_fkey') THEN ALTER TABLE public.currency_settings ADD CONSTRAINT currency_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_fee_overrides_user_id_fkey') THEN ALTER TABLE public.customer_fee_overrides ADD CONSTRAINT customer_fee_overrides_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_fee_overrides_created_by_fkey') THEN ALTER TABLE public.customer_fee_overrides ADD CONSTRAINT customer_fee_overrides_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_limit_overrides_created_by_fkey') THEN ALTER TABLE public.customer_limit_overrides ADD CONSTRAINT customer_limit_overrides_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_limit_overrides_user_id_fkey') THEN ALTER TABLE public.customer_limit_overrides ADD CONSTRAINT customer_limit_overrides_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exchange_rates_config_updated_by_fkey') THEN ALTER TABLE public.exchange_rates_config ADD CONSTRAINT exchange_rates_config_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES profiles(id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'idempotency_keys_user_id_fkey') THEN ALTER TABLE public.idempotency_keys ADD CONSTRAINT idempotency_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kyb_applications_business_id_fkey') THEN ALTER TABLE public.kyb_applications ADD CONSTRAINT kyb_applications_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kyb_applications_requester_user_id_fkey') THEN ALTER TABLE public.kyb_applications ADD CONSTRAINT kyb_applications_requester_user_id_fkey FOREIGN KEY (requester_user_id) REFERENCES profiles(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kyc_applications_person_id_fkey') THEN ALTER TABLE public.kyc_applications ADD CONSTRAINT kyc_applications_person_id_fkey FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE SET NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kyc_applications_user_id_fkey') THEN ALTER TABLE public.kyc_applications ADD CONSTRAINT kyc_applications_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'people_user_id_fkey') THEN ALTER TABLE public.people ADD CONSTRAINT people_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reconciliation_runs_initiated_by_fkey') THEN ALTER TABLE public.reconciliation_runs ADD CONSTRAINT reconciliation_runs_initiated_by_fkey FOREIGN KEY (initiated_by) REFERENCES profiles(id) ON DELETE SET NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rejection_templates_created_by_fkey') THEN ALTER TABLE public.rejection_templates ADD CONSTRAINT rejection_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transaction_limits_user_id_fkey') THEN ALTER TABLE public.transaction_limits ADD CONSTRAINT transaction_limits_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transaction_limits_applied_by_fkey') THEN ALTER TABLE public.transaction_limits ADD CONSTRAINT transaction_limits_applied_by_fkey FOREIGN KEY (applied_by) REFERENCES profiles(id) ON DELETE SET NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'va_fee_defaults_updated_by_fkey') THEN ALTER TABLE public.va_fee_defaults ADD CONSTRAINT va_fee_defaults_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES profiles(id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'va_fee_overrides_user_id_fkey') THEN ALTER TABLE public.va_fee_overrides ADD CONSTRAINT va_fee_overrides_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'va_fee_overrides_set_by_fkey') THEN ALTER TABLE public.va_fee_overrides ADD CONSTRAINT va_fee_overrides_set_by_fkey FOREIGN KEY (set_by) REFERENCES profiles(id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'va_source_currency_settings_updated_by_fkey') THEN ALTER TABLE public.va_source_currency_settings ADD CONSTRAINT va_source_currency_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id); END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. Índices (los que respaldan constraints ya se crearon arriba)
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_auth_audit_log_event_type_created ON public.auth_audit_log USING btree (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_audit_log_ip_created ON public.auth_audit_log USING btree (ip_address, created_at DESC) WHERE (ip_address IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_auth_audit_log_user_created ON public.auth_audit_log USING btree (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_audit_log_user_id ON public.auth_audit_log USING btree (user_id) WHERE (user_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_balances_user_id ON public.balances USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_bridge_kyc_links_kyc_application_id ON public.bridge_kyc_links USING btree (kyc_application_id);
CREATE INDEX IF NOT EXISTS idx_bridge_kyc_links_user_id ON public.bridge_kyc_links USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_bridge_liquidation_addresses_user_id ON public.bridge_liquidation_addresses USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_bridge_pull_jobs_initiated_by ON public.bridge_pull_jobs USING btree (initiated_by);
CREATE INDEX IF NOT EXISTS idx_bridge_pull_jobs_status ON public.bridge_pull_jobs USING btree (status);
CREATE INDEX IF NOT EXISTS idx_bridge_pull_jobs_target_user_id ON public.bridge_pull_jobs USING btree (target_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS business_directors_bridge_associated_person_id_key ON public.business_directors USING btree (bridge_associated_person_id) WHERE (bridge_associated_person_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_business_directors_business_id ON public.business_directors USING btree (business_id);
CREATE INDEX IF NOT EXISTS idx_business_directors_document_id ON public.business_directors USING btree (document_id);
CREATE UNIQUE INDEX IF NOT EXISTS business_ubos_bridge_associated_person_id_key ON public.business_ubos USING btree (bridge_associated_person_id) WHERE (bridge_associated_person_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_business_ubos_business_id ON public.business_ubos USING btree (business_id);
CREATE INDEX IF NOT EXISTS idx_business_ubos_document_id ON public.business_ubos USING btree (document_id);
CREATE INDEX IF NOT EXISTS idx_businesses_user_id ON public.businesses USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_certificates_user_id ON public.certificates USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_client_bank_accounts_status ON public.client_bank_accounts USING btree (status);
CREATE INDEX IF NOT EXISTS idx_client_bank_accounts_user_id ON public.client_bank_accounts USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_compliance_review_comments_author_id ON public.compliance_review_comments USING btree (author_id);
CREATE INDEX IF NOT EXISTS idx_compliance_review_comments_review_id ON public.compliance_review_comments USING btree (review_id);
CREATE INDEX IF NOT EXISTS idx_compliance_review_events_actor_id ON public.compliance_review_events USING btree (actor_id);
CREATE INDEX IF NOT EXISTS idx_compliance_review_events_review_id ON public.compliance_review_events USING btree (review_id);
CREATE INDEX IF NOT EXISTS idx_compliance_reviews_assigned_to ON public.compliance_reviews USING btree (assigned_to);
CREATE INDEX IF NOT EXISTS idx_compliance_reviews_open ON public.compliance_reviews USING btree (priority DESC, opened_at) WHERE (status = 'open'::text);
CREATE INDEX IF NOT EXISTS idx_compliance_reviews_status ON public.compliance_reviews USING btree (status);
CREATE INDEX IF NOT EXISTS idx_compliance_reviews_subject ON public.compliance_reviews USING btree (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_customer_fee_overrides_created_by ON public.customer_fee_overrides USING btree (created_by);
CREATE INDEX IF NOT EXISTS idx_fee_overrides_lookup ON public.customer_fee_overrides USING btree (user_id, operation_type, is_active) WHERE (is_active = true);
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_fee_override_v2 ON public.customer_fee_overrides USING btree (user_id, operation_type, payment_rail, currency) WHERE (is_active = true);
CREATE UNIQUE INDEX IF NOT EXISTS customer_limit_overrides_active_uniq ON public.customer_limit_overrides USING btree (user_id, flow_type) WHERE (is_active = true);
CREATE INDEX IF NOT EXISTS customer_limit_overrides_flow_type_idx ON public.customer_limit_overrides USING btree (flow_type);
CREATE INDEX IF NOT EXISTS customer_limit_overrides_user_id_idx ON public.customer_limit_overrides USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_exchange_rates_config_updated_by ON public.exchange_rates_config USING btree (updated_by);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires ON public.idempotency_keys USING btree (expires_at);
CREATE INDEX IF NOT EXISTS idx_kyb_applications_business_id ON public.kyb_applications USING btree (business_id);
CREATE INDEX IF NOT EXISTS idx_kyb_applications_requester_user_id ON public.kyb_applications USING btree (requester_user_id);
CREATE INDEX IF NOT EXISTS idx_kyc_applications_person_id ON public.kyc_applications USING btree (person_id);
CREATE INDEX IF NOT EXISTS idx_kyc_applications_status ON public.kyc_applications USING btree (status);
CREATE INDEX IF NOT EXISTS idx_kyc_applications_user_id ON public.kyc_applications USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_people_user_id ON public.people USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_initiated_by ON public.reconciliation_runs USING btree (initiated_by);
CREATE INDEX IF NOT EXISTS idx_rejection_templates_category ON public.rejection_templates USING btree (category, is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_rejection_templates_created_by ON public.rejection_templates USING btree (created_by);
CREATE INDEX IF NOT EXISTS idx_transaction_limits_applied_by ON public.transaction_limits USING btree (applied_by);
CREATE INDEX IF NOT EXISTS idx_transaction_limits_user_id ON public.transaction_limits USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_va_fee_defaults_updated_by ON public.va_fee_defaults USING btree (updated_by);
CREATE INDEX IF NOT EXISTS idx_va_fee_overrides_set_by ON public.va_fee_overrides USING btree (set_by);
CREATE INDEX IF NOT EXISTS idx_va_fee_overrides_user_id ON public.va_fee_overrides USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_provider_event_id ON public.webhook_events USING btree (provider_event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON public.webhook_events USING btree (status, retry_count);
CREATE INDEX IF NOT EXISTS idx_webhook_status_date ON public.webhook_events USING btree (status, received_at) WHERE (status = ANY (ARRAY['pending'::text, 'processing'::text]));

-- ----------------------------------------------------------------------------
-- 4. Row Level Security
-- ----------------------------------------------------------------------------

ALTER TABLE public.auth_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bridge_kyc_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bridge_liquidation_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bridge_pull_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_directors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_ubos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_review_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_review_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.currency_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_fee_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_limit_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exchange_rates_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kyb_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kyc_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.people ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rejection_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.va_fee_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.va_fee_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.va_source_currency_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 5. Políticas RLS
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='auth_audit_log' AND policyname='auth_audit_log: usuario ve los suyos') THEN
    CREATE POLICY "auth_audit_log: usuario ve los suyos" ON public.auth_audit_log FOR SELECT TO public USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='auth_audit_log' AND policyname='staff_read_auth_audit_log') THEN
    CREATE POLICY "staff_read_auth_audit_log" ON public.auth_audit_log FOR SELECT TO public USING (private.is_staff_or_admin());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='balances' AND policyname='balances: usuario ve los suyos') THEN
    CREATE POLICY "balances: usuario ve los suyos" ON public.balances FOR SELECT TO public USING (( SELECT auth.uid()) = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='balances' AND policyname='staff_read_balances') THEN
    CREATE POLICY "staff_read_balances" ON public.balances FOR SELECT TO public USING (private.is_staff_or_admin());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='bridge_kyc_links' AND policyname='bridge_kyc_links: usuario ve los suyos') THEN
    CREATE POLICY "bridge_kyc_links: usuario ve los suyos" ON public.bridge_kyc_links FOR SELECT TO public USING (( SELECT auth.uid()) = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='bridge_kyc_links' AND policyname='staff_read_bridge_kyc_links') THEN
    CREATE POLICY "staff_read_bridge_kyc_links" ON public.bridge_kyc_links FOR SELECT TO public USING (private.is_staff_or_admin());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='bridge_liquidation_addresses' AND policyname='bridge_liquidation_addresses: usuario ve los suyos') THEN
    CREATE POLICY "bridge_liquidation_addresses: usuario ve los suyos" ON public.bridge_liquidation_addresses FOR SELECT TO public USING (( SELECT auth.uid()) = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='bridge_liquidation_addresses' AND policyname='staff_read_bridge_liquidation_addresses') THEN
    CREATE POLICY "staff_read_bridge_liquidation_addresses" ON public.bridge_liquidation_addresses FOR SELECT TO public USING (private.is_staff_or_admin());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='bridge_pull_jobs' AND policyname='service_role_all_bridge_pull_jobs') THEN
    CREATE POLICY "service_role_all_bridge_pull_jobs" ON public.bridge_pull_jobs FOR ALL TO public USING (( SELECT auth.role()) = 'service_role'::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='bridge_pull_jobs' AND policyname='staff_read_bridge_pull_jobs') THEN
    CREATE POLICY "staff_read_bridge_pull_jobs" ON public.bridge_pull_jobs FOR SELECT TO public USING (private.is_staff_or_admin());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='business_directors' AND policyname='client_read_own_directors') THEN
    CREATE POLICY "client_read_own_directors" ON public.business_directors FOR SELECT TO public USING (EXISTS (SELECT 1 FROM businesses b WHERE b.id = business_directors.business_id AND b.user_id = (SELECT auth.uid())));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='business_directors' AND policyname='service_role_all_business_directors') THEN
    CREATE POLICY "service_role_all_business_directors" ON public.business_directors FOR ALL TO public USING (( SELECT auth.role()) = 'service_role'::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='business_directors' AND policyname='staff_read_all_directors') THEN
    CREATE POLICY "staff_read_all_directors" ON public.business_directors FOR SELECT TO public USING (private.is_staff_or_admin());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='business_ubos' AND policyname='client_read_own_ubos') THEN
    CREATE POLICY "client_read_own_ubos" ON public.business_ubos FOR SELECT TO public USING (EXISTS (SELECT 1 FROM businesses b WHERE b.id = business_ubos.business_id AND b.user_id = (SELECT auth.uid())));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='business_ubos' AND policyname='service_role_all_business_ubos') THEN
    CREATE POLICY "service_role_all_business_ubos" ON public.business_ubos FOR ALL TO public USING (( SELECT auth.role()) = 'service_role'::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='business_ubos' AND policyname='staff_read_all_ubos') THEN
    CREATE POLICY "staff_read_all_ubos" ON public.business_ubos FOR SELECT TO public USING (private.is_staff_or_admin());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='businesses' AND policyname='businesses: staff puede leer todos') THEN
    CREATE POLICY "businesses: staff puede leer todos" ON public.businesses FOR SELECT TO public USING (private.is_staff_or_admin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='businesses' AND policyname='businesses: usuario actualiza los suyos') THEN
    CREATE POLICY "businesses: usuario actualiza los suyos" ON public.businesses FOR UPDATE TO public USING (( SELECT auth.uid()) = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='businesses' AND policyname='businesses: usuario inserta los suyos') THEN
    CREATE POLICY "businesses: usuario inserta los suyos" ON public.businesses FOR INSERT TO public WITH CHECK (( SELECT auth.uid()) = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='businesses' AND policyname='businesses: usuario ve los suyos') THEN
    CREATE POLICY "businesses: usuario ve los suyos" ON public.businesses FOR SELECT TO public USING (( SELECT auth.uid()) = user_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='certificates' AND policyname='certificates: usuario ve los suyos') THEN
    CREATE POLICY "certificates: usuario ve los suyos" ON public.certificates FOR SELECT TO public USING (( SELECT auth.uid()) = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='certificates' AND policyname='staff_read_certificates') THEN
    CREATE POLICY "staff_read_certificates" ON public.certificates FOR SELECT TO public USING (private.is_staff_or_admin());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='client_bank_accounts' AND policyname='staff_update_all_bank_accounts') THEN
    CREATE POLICY "staff_update_all_bank_accounts" ON public.client_bank_accounts FOR UPDATE TO public USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = (SELECT auth.uid()) AND profiles.role = ANY (ARRAY['staff'::text,'admin'::text,'super_admin'::text])));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='client_bank_accounts' AND policyname='staff_view_all_bank_accounts') THEN
    CREATE POLICY "staff_view_all_bank_accounts" ON public.client_bank_accounts FOR SELECT TO public USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = (SELECT auth.uid()) AND profiles.role = ANY (ARRAY['staff'::text,'admin'::text,'super_admin'::text])));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='client_bank_accounts' AND policyname='users_manage_own_bank_accounts') THEN
    CREATE POLICY "users_manage_own_bank_accounts" ON public.client_bank_accounts FOR ALL TO public USING (( SELECT auth.uid()) = user_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='compliance_review_comments' AND policyname='service_role_all_compliance_comments') THEN
    CREATE POLICY "service_role_all_compliance_comments" ON public.compliance_review_comments FOR ALL TO public USING (( SELECT auth.role()) = 'service_role'::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='compliance_review_comments' AND policyname='staff_all_compliance_comments') THEN
    CREATE POLICY "staff_all_compliance_comments" ON public.compliance_review_comments FOR ALL TO public USING (private.is_staff_or_admin());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='compliance_review_events' AND policyname='service_role_all_compliance_events') THEN
    CREATE POLICY "service_role_all_compliance_events" ON public.compliance_review_events FOR ALL TO public USING (( SELECT auth.role()) = 'service_role'::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='compliance_review_events' AND policyname='staff_read_compliance_events') THEN
    CREATE POLICY "staff_read_compliance_events" ON public.compliance_review_events FOR SELECT TO public USING (private.is_staff_or_admin());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='compliance_reviews' AND policyname='compliance_reviews: usuario ve las suyas') THEN
    CREATE POLICY "compliance_reviews: usuario ve las suyas" ON public.compliance_reviews FOR SELECT TO public USING (
      subject_id IN (
        SELECT kyc_applications.id FROM kyc_applications WHERE kyc_applications.user_id = (SELECT auth.uid())
        UNION
        SELECT b.id FROM kyb_applications ba JOIN businesses b ON b.id = ba.business_id WHERE ba.requester_user_id = (SELECT auth.uid())
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='compliance_reviews' AND policyname='staff_all_compliance_reviews') THEN
    CREATE POLICY "staff_all_compliance_reviews" ON public.compliance_reviews FOR ALL TO public USING (private.is_staff_or_admin());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='currency_settings' AND policyname='currency_settings_select') THEN
    CREATE POLICY "currency_settings_select" ON public.currency_settings FOR SELECT TO public USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='currency_settings' AND policyname='currency_settings_service_write') THEN
    CREATE POLICY "currency_settings_service_write" ON public.currency_settings FOR ALL TO public USING (auth.role() = 'service_role'::text);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='customer_fee_overrides' AND policyname='service_role_all_fee_overrides') THEN
    CREATE POLICY "service_role_all_fee_overrides" ON public.customer_fee_overrides FOR ALL TO public USING (( SELECT auth.role()) = 'service_role'::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='customer_fee_overrides' AND policyname='staff_all_fee_overrides') THEN
    CREATE POLICY "staff_all_fee_overrides" ON public.customer_fee_overrides FOR ALL TO public USING (private.is_staff_or_admin());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='customer_limit_overrides' AND policyname='service_role_full_access') THEN
    CREATE POLICY "service_role_full_access" ON public.customer_limit_overrides FOR ALL TO public USING (auth.role() = 'service_role'::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='customer_limit_overrides' AND policyname='staff_all_customer_limit_overrides') THEN
    CREATE POLICY "staff_all_customer_limit_overrides" ON public.customer_limit_overrides FOR ALL TO public USING (private.is_staff_or_admin()) WITH CHECK (private.is_staff_or_admin());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='exchange_rates_config' AND policyname='admin_full_access') THEN
    CREATE POLICY "admin_full_access" ON public.exchange_rates_config FOR ALL TO public USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = (SELECT auth.uid()) AND profiles.role = ANY (ARRAY['admin'::text,'super_admin'::text])));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='exchange_rates_config' AND policyname='authenticated_read') THEN
    CREATE POLICY "authenticated_read" ON public.exchange_rates_config FOR SELECT TO public USING (( SELECT auth.role()) = 'authenticated'::text);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='idempotency_keys' AND policyname='idempotency_keys_user_policy') THEN
    CREATE POLICY "idempotency_keys_user_policy" ON public.idempotency_keys FOR ALL TO public USING (user_id = auth.uid());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='kyb_applications' AND policyname='kyb_applications: staff puede leer todas') THEN
    CREATE POLICY "kyb_applications: staff puede leer todas" ON public.kyb_applications FOR SELECT TO public USING (private.is_staff_or_admin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='kyb_applications' AND policyname='kyb_applications: usuario ve los suyos') THEN
    CREATE POLICY "kyb_applications: usuario ve los suyos" ON public.kyb_applications FOR SELECT TO public USING (( SELECT auth.uid()) = requester_user_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='kyc_applications' AND policyname='kyc_applications: staff puede leer todas') THEN
    CREATE POLICY "kyc_applications: staff puede leer todas" ON public.kyc_applications FOR SELECT TO public USING (private.is_staff_or_admin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='kyc_applications' AND policyname='kyc_applications: usuario ve los suyos') THEN
    CREATE POLICY "kyc_applications: usuario ve los suyos" ON public.kyc_applications FOR SELECT TO public USING (( SELECT auth.uid()) = user_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='people' AND policyname='people: staff puede leer todos') THEN
    CREATE POLICY "people: staff puede leer todos" ON public.people FOR SELECT TO public USING (private.is_staff_or_admin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='people' AND policyname='people: usuario actualiza el suyo') THEN
    CREATE POLICY "people: usuario actualiza el suyo" ON public.people FOR UPDATE TO public USING (( SELECT auth.uid()) = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='people' AND policyname='people: usuario inserta el suyo') THEN
    CREATE POLICY "people: usuario inserta el suyo" ON public.people FOR INSERT TO public WITH CHECK (( SELECT auth.uid()) = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='people' AND policyname='people: usuario ve el suyo') THEN
    CREATE POLICY "people: usuario ve el suyo" ON public.people FOR SELECT TO public USING (( SELECT auth.uid()) = user_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='reconciliation_runs' AND policyname='service_role_all_reconciliation') THEN
    CREATE POLICY "service_role_all_reconciliation" ON public.reconciliation_runs FOR ALL TO public USING (( SELECT auth.role()) = 'service_role'::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='reconciliation_runs' AND policyname='staff_read_reconciliation') THEN
    CREATE POLICY "staff_read_reconciliation" ON public.reconciliation_runs FOR SELECT TO public USING (private.is_staff_or_admin());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='rejection_templates' AND policyname='admin_manage_templates') THEN
    CREATE POLICY "admin_manage_templates" ON public.rejection_templates FOR ALL TO public USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = (SELECT auth.uid()) AND profiles.role = ANY (ARRAY['admin'::text,'super_admin'::text])));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='rejection_templates' AND policyname='staff_read_templates') THEN
    CREATE POLICY "staff_read_templates" ON public.rejection_templates FOR SELECT TO public USING (private.is_staff_or_admin());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='transaction_limits' AND policyname='client_read_own_limits') THEN
    CREATE POLICY "client_read_own_limits" ON public.transaction_limits FOR SELECT TO public USING (user_id = (SELECT auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='transaction_limits' AND policyname='service_role_all_transaction_limits') THEN
    CREATE POLICY "service_role_all_transaction_limits" ON public.transaction_limits FOR ALL TO public USING (( SELECT auth.role()) = 'service_role'::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='transaction_limits' AND policyname='staff_all_transaction_limits') THEN
    CREATE POLICY "staff_all_transaction_limits" ON public.transaction_limits FOR ALL TO public USING (private.is_staff_or_admin());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='va_fee_defaults' AND policyname='staff_all_va_fee_defaults') THEN
    CREATE POLICY "staff_all_va_fee_defaults" ON public.va_fee_defaults FOR ALL TO public USING (private.is_staff_or_admin()) WITH CHECK (private.is_staff_or_admin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='va_fee_defaults' AND policyname='va_fee_defaults: service_role full access') THEN
    CREATE POLICY "va_fee_defaults: service_role full access" ON public.va_fee_defaults FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='va_fee_overrides' AND policyname='staff_all_va_fee_overrides') THEN
    CREATE POLICY "staff_all_va_fee_overrides" ON public.va_fee_overrides FOR ALL TO public USING (private.is_staff_or_admin()) WITH CHECK (private.is_staff_or_admin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='va_fee_overrides' AND policyname='va_fee_overrides: service_role full access') THEN
    CREATE POLICY "va_fee_overrides: service_role full access" ON public.va_fee_overrides FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='va_source_currency_settings' AND policyname='staff_update_va_source_currency_settings') THEN
    CREATE POLICY "staff_update_va_source_currency_settings" ON public.va_source_currency_settings FOR UPDATE TO public USING (private.is_staff_or_admin()) WITH CHECK (private.is_staff_or_admin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='va_source_currency_settings' AND policyname='va_source_select') THEN
    CREATE POLICY "va_source_select" ON public.va_source_currency_settings FOR SELECT TO public USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='va_source_currency_settings' AND policyname='va_source_service_write') THEN
    CREATE POLICY "va_source_service_write" ON public.va_source_currency_settings FOR ALL TO public USING (auth.role() = 'service_role'::text);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='webhook_events' AND policyname='service_role_all_webhook_events') THEN
    CREATE POLICY "service_role_all_webhook_events" ON public.webhook_events FOR ALL TO public USING (( SELECT auth.role()) = 'service_role'::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='webhook_events' AND policyname='staff_read_webhook_events') THEN
    CREATE POLICY "staff_read_webhook_events" ON public.webhook_events FOR SELECT TO public USING (private.is_staff_or_admin());
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 6. Triggers (las funciones referenciadas ya existen — se usan en tablas
--    que sí tienen migración propia)
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_updated_at ON public.balances;
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.balances FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

DROP TRIGGER IF EXISTS trg_updated_at ON public.bridge_kyc_links;
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.bridge_kyc_links FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

DROP TRIGGER IF EXISTS handle_updated_at ON public.bridge_liquidation_addresses;
CREATE TRIGGER handle_updated_at BEFORE UPDATE ON public.bridge_liquidation_addresses FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS handle_updated_at ON public.bridge_pull_jobs;
CREATE TRIGGER handle_updated_at BEFORE UPDATE ON public.bridge_pull_jobs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_updated_at ON public.business_directors;
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.business_directors FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

DROP TRIGGER IF EXISTS trg_updated_at ON public.business_ubos;
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.business_ubos FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

DROP TRIGGER IF EXISTS trg_updated_at ON public.businesses;
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.businesses FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

DROP TRIGGER IF EXISTS handle_updated_at ON public.certificates;
CREATE TRIGGER handle_updated_at BEFORE UPDATE ON public.certificates FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS handle_updated_at ON public.compliance_review_comments;
CREATE TRIGGER handle_updated_at BEFORE UPDATE ON public.compliance_review_comments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS immutable_compliance_review_events ON public.compliance_review_events;
CREATE TRIGGER immutable_compliance_review_events BEFORE DELETE OR UPDATE ON public.compliance_review_events FOR EACH ROW EXECUTE FUNCTION prevent_immutable_update();

DROP TRIGGER IF EXISTS handle_updated_at ON public.compliance_reviews;
CREATE TRIGGER handle_updated_at BEFORE UPDATE ON public.compliance_reviews FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_updated_at ON public.customer_fee_overrides;
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.customer_fee_overrides FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

DROP TRIGGER IF EXISTS trg_customer_limit_overrides_updated_at ON public.customer_limit_overrides;
CREATE TRIGGER trg_customer_limit_overrides_updated_at BEFORE UPDATE ON public.customer_limit_overrides FOR EACH ROW EXECUTE FUNCTION update_customer_limit_overrides_updated_at();

DROP TRIGGER IF EXISTS audit_kyb_applications ON public.kyb_applications;
CREATE TRIGGER audit_kyb_applications AFTER UPDATE ON public.kyb_applications FOR EACH ROW EXECUTE FUNCTION audit_sensitive_tables();

DROP TRIGGER IF EXISTS on_kyb_submitted ON public.kyb_applications;
CREATE TRIGGER on_kyb_submitted AFTER UPDATE ON public.kyb_applications FOR EACH ROW EXECUTE FUNCTION handle_kyb_submitted();

DROP TRIGGER IF EXISTS trg_updated_at ON public.kyb_applications;
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.kyb_applications FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

DROP TRIGGER IF EXISTS audit_kyc_applications ON public.kyc_applications;
CREATE TRIGGER audit_kyc_applications AFTER UPDATE ON public.kyc_applications FOR EACH ROW EXECUTE FUNCTION audit_sensitive_tables();

DROP TRIGGER IF EXISTS on_kyc_submitted ON public.kyc_applications;
CREATE TRIGGER on_kyc_submitted AFTER UPDATE ON public.kyc_applications FOR EACH ROW EXECUTE FUNCTION handle_kyc_submitted();

DROP TRIGGER IF EXISTS trg_updated_at ON public.kyc_applications;
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.kyc_applications FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

DROP TRIGGER IF EXISTS trg_updated_at ON public.people;
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.people FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

DROP TRIGGER IF EXISTS handle_updated_at ON public.reconciliation_runs;
CREATE TRIGGER handle_updated_at BEFORE UPDATE ON public.reconciliation_runs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_updated_at ON public.transaction_limits;
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.transaction_limits FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
