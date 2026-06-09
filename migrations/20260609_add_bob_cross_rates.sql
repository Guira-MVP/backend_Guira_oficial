-- Añade los 10 pares cruzados derivados de BOB/USD × Bridge midmarket.
-- Los valores iniciales son placeholders; el primer cron los sobreescribe.
INSERT INTO exchange_rates_config (pair, rate, spread_percent, updated_by, updated_at)
VALUES
  ('BOB_EUR', 10.00,   1.0, NULL, now()),
  ('EUR_BOB', 9.94,    1.0, NULL, now()),
  ('BOB_MXN', 0.53,    1.0, NULL, now()),
  ('MXN_BOB', 0.52,    1.0, NULL, now()),
  ('BOB_BRL', 1.70,    1.0, NULL, now()),
  ('BRL_BOB', 1.68,    1.0, NULL, now()),
  ('BOB_COP', 0.0023,  1.0, NULL, now()),
  ('COP_BOB', 0.0022,  1.0, NULL, now()),
  ('BOB_GBP', 11.80,   1.0, NULL, now()),
  ('GBP_BOB', 11.76,   1.0, NULL, now())
ON CONFLICT (pair) DO NOTHING;
