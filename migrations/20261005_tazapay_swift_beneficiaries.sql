-- Beneficiarios SWIFT en Tazapay (primera etapa: solo alta, sin payouts).
--
-- Un proveedor SWIFT es una fila de `suppliers` con payment_rail = 'swift'
-- (sin external account ni liquidation address de Bridge) más una fila hija
-- en `tazapay_beneficiaries` con el bnf_ de Tazapay. Tazapay no ata el
-- beneficiario al cliente: la relación la guarda Guira.
--
--   tazapay_beneficiaries   bnf_/bnk_ de cada proveedor SWIFT, estado del alta
--                           e idempotency key (los reintentos no duplican).
--   tazapay_corridor_cache  respuesta de GET /v3/metadata/payout/bank por país
--                           (vigencia 24 h; la consulta sin moneda trae todos
--                           los corredores SWIFT del país).
--   tazapay_corridor_rules  reglas que la metadata no trae (teléfono chino,
--                           RUT chileno, bancos bloqueados…). Datos, no código.
--   suppliers               el índice único por (email, rail) deja fuera a
--                           swift: un contacto puede tener una cuenta SWIFT por
--                           país de banco y moneda.
--   app_settings            interruptor y lista de monedas permitidas.
--
-- Tablas nuevas: RLS activo sin policies (solo service_role). REVOKE explícito
-- a anon y authenticated: REVOKE FROM PUBLIC no alcanza en Supabase.

-- ── tazapay_beneficiaries ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tazapay_beneficiaries (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  supplier_id            uuid NOT NULL UNIQUE REFERENCES public.suppliers(id) ON DELETE CASCADE,
  tazapay_beneficiary_id text UNIQUE,          -- bnf_… (NULL mientras está pending)
  destination_id         text,                 -- bnk_…
  destination_type       text NOT NULL DEFAULT 'bank',
  payout_type            text NOT NULL DEFAULT 'swift',
  beneficiary_type       text NOT NULL CHECK (beneficiary_type IN ('individual', 'business')),
  country                char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  currency               char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  swift_code             text NOT NULL,
  account_last_4         text,
  status                 text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'active', 'inactive', 'failed')),
  has_successful_payout  boolean NOT NULL DEFAULT false,
  idempotency_key        text NOT NULL UNIQUE,
  attempt_count          integer NOT NULL DEFAULT 0,
  last_error_code        text,
  last_error_message     text,
  request_payload        jsonb,   -- REDACTADO: sin número de cuenta/IBAN completos ni teléfono
  raw_response           jsonb,   -- REDACTADO
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tazapay_beneficiaries_user_idx
  ON public.tazapay_beneficiaries (user_id);
CREATE INDEX IF NOT EXISTS tazapay_beneficiaries_pending_idx
  ON public.tazapay_beneficiaries (updated_at) WHERE status = 'pending';

DROP TRIGGER IF EXISTS trg_updated_at ON public.tazapay_beneficiaries;
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.tazapay_beneficiaries
  FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

-- ── tazapay_corridor_cache ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tazapay_corridor_cache (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country     char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  payout_type text NOT NULL DEFAULT 'swift',
  response    jsonb NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (country, payout_type)
);

-- ── tazapay_corridor_rules ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tazapay_corridor_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country          char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  currency         char(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'), -- NULL = cualquier moneda
  beneficiary_type text CHECK (beneficiary_type IS NULL OR beneficiary_type IN ('individual', 'business')),
  rule_type        text NOT NULL CHECK (rule_type IN (
                     'require_field',          -- agrega un campo obligatorio
                     'recommend_field',        -- agrega un campo opcional marcado "recomendado"
                     'field_pattern',          -- regex para un campo
                     'allowed_swift_prefixes', -- solo estos bancos
                     'blocked_swift_codes',    -- estos bancos no
                     'payout_requirement',     -- aviso de lo que se pedirá al pagar
                     'notice')),               -- aviso al cliente
  field_key        text,          -- clave del diccionario de campos, si aplica
  value            jsonb NOT NULL DEFAULT '{}'::jsonb,
  message_es       text,          -- texto para el cliente
  source           text NOT NULL, -- ruta de la doc de Tazapay
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (country, currency, beneficiary_type, rule_type, field_key)
);
CREATE INDEX IF NOT EXISTS tazapay_corridor_rules_country_idx
  ON public.tazapay_corridor_rules (country) WHERE is_active;

DROP TRIGGER IF EXISTS trg_updated_at ON public.tazapay_corridor_rules;
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.tazapay_corridor_rules
  FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

-- Carga inicial (documentación de Tazapay descargada el 2026-09-25).
INSERT INTO public.tazapay_corridor_rules
  (country, currency, beneficiary_type, rule_type, field_key, value, message_es, source)
VALUES
  ('CN', NULL, NULL, 'require_field', 'phone', '{}'::jsonb,
   'China exige el teléfono móvil del beneficiario.',
   'api-reference/tazapay-api/beneficiary.md'),
  ('CN', NULL, NULL, 'field_pattern', 'phone.number', '{"pattern": "^1[3-9][0-9]{9}$"}'::jsonb,
   'Debe ser un móvil chino de 11 dígitos que empiece con 13-19.',
   'api-reference/tazapay-api/beneficiary.md'),
  ('CN', NULL, NULL, 'field_pattern', 'phone.calling_code', '{"pattern": "^\\+?86$"}'::jsonb,
   'El código de país debe ser 86 (China).',
   'api-reference/tazapay-api/beneficiary.md'),
  ('CN', NULL, NULL, 'recommend_field', 'name_local', '{}'::jsonb,
   'Nombre del beneficiario en caracteres chinos, tal como figura en el banco.',
   'payouts/local-payouts/china-cny'),
  ('CL', 'CLP', NULL, 'require_field', 'tax_id', '{}'::jsonb,
   'RUT (empresa, 9 dígitos) o RUN (persona, 8 dígitos).',
   'product-releases/2026/swift-payout-corridor-expansion.md'),
  ('AO', 'AOA', NULL, 'require_field', 'tax_id', '{}'::jsonb,
   'NIF (empresa, 10 caracteres; persona, 14).',
   'product-releases/2026/swift-payout-corridor-expansion.md'),
  -- El código que publica Tazapay está mal formado (letras 5-6 = "FB", no
  -- "BO"), así que la validación de país ya lo rechaza; se deja tal cual
  -- figura en la doc y el aviso explica la restricción.
  ('BO', 'BOB', NULL, 'blocked_swift_codes', 'bank_codes.swift_code', '{"codes": ["BSCBFBO2XXX", "BSCBFBO2"]}'::jsonb,
   'Tazapay no paga en bolivianos a Banco Fassil.',
   'product-releases/2026/swift-payout-corridor-expansion.md'),
  -- La doc no da el SWIFT de Citibank Uruguay: queda como aviso hasta confirmarlo.
  ('UY', 'UYU', NULL, 'notice', NULL, '{}'::jsonb,
   'Los pagos en pesos uruguayos solo llegan a cuentas de Citibank Uruguay.',
   'product-releases/2026/swift-payout-corridor-expansion.md'),
  ('GT', 'GTQ', 'individual', 'allowed_swift_prefixes', 'bank_codes.swift_code', '{"prefixes": ["INDLGTGC"]}'::jsonb,
   'Los pagos en quetzales a personas solo llegan a Banco Industrial.',
   'product-releases/2026/swift-payout-corridor-expansion.md'),
  ('CO', 'COP', NULL, 'notice', NULL, '{}'::jsonb,
   'Solo algunos bancos colombianos reciben pesos por SWIFT, y el beneficiario puede tener que llenar formularios en su banco.',
   'product-releases/2026/swift-payout-corridor-expansion.md'),
  ('HN', 'HNL', NULL, 'notice', NULL, '{}'::jsonb,
   'En lempiras, los pagos de empresa a persona solo se admiten por sueldo o reembolso médico.',
   'product-releases/2026/swift-payout-corridor-expansion.md')
ON CONFLICT DO NOTHING;

-- ── RLS y permisos ────────────────────────────────────────────────────────
ALTER TABLE public.tazapay_beneficiaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tazapay_corridor_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tazapay_corridor_rules ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.tazapay_beneficiaries FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.tazapay_corridor_cache FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.tazapay_corridor_rules FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.tazapay_beneficiaries TO service_role;
GRANT ALL ON TABLE public.tazapay_corridor_cache TO service_role;
GRANT ALL ON TABLE public.tazapay_corridor_rules TO service_role;

-- ── suppliers: unicidad de SWIFT por país de banco y moneda ───────────────
-- Primero el índice nuevo; después se reemplaza el de fiat por uno que deja
-- fuera a swift (se crea con nombre temporal y se renombra, para que nunca
-- haya un momento sin índice para los rails de Bridge).
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_unique_swift_email_country_currency
  ON public.suppliers (user_id, contact_email, currency, (bank_details ->> 'bank_country'))
  WHERE is_active = true AND contact_email IS NOT NULL AND payment_rail = 'swift';

CREATE UNIQUE INDEX IF NOT EXISTS suppliers_unique_fiat_email_rail_v2
  ON public.suppliers (user_id, contact_email, payment_rail)
  WHERE is_active = true AND contact_email IS NOT NULL AND payment_rail NOT IN ('crypto', 'swift');
DROP INDEX IF EXISTS public.suppliers_unique_fiat_email_rail;
ALTER INDEX public.suppliers_unique_fiat_email_rail_v2 RENAME TO suppliers_unique_fiat_email_rail;

-- ── Interruptores ─────────────────────────────────────────────────────────
INSERT INTO public.app_settings (key, value, type, description, is_public)
VALUES
  ('TAZAPAY_SWIFT_BENEFICIARIES_ENABLED', 'false', 'boolean',
   'Permite a los clientes KYB con entity aprobada en Tazapay registrar beneficiarios SWIFT.',
   false),
  ('TAZAPAY_SWIFT_ALLOWED_CURRENCIES', '', 'string',
   'Monedas SWIFT ofrecidas al cliente, separadas por coma (p. ej. "USD,EUR"). Vacío = todas las que devuelva Tazapay.',
   false)
ON CONFLICT (key) DO NOTHING;
