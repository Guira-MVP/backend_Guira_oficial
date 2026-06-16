-- Agrega filas USD_X en exchange_rates_config para el flujo bridge_wallet_to_fiat_us.
--
-- Contexto:
--   La tabla solo tenía pares BOB↔X. El flujo USDC→MXN/EUR/BRL/COP/GBP necesita
--   pares dedicados USD_X donde:
--     - rate        = bridge_sell_rate (Bridge vende la divisa al cliente)
--     - spread_percent = buffer de display (0.50 %); NO es un fee extra de revenue
--     - bridge_buy_rate / bridge_sell_rate se guardan para auditoría
--
--   Los valores iniciales se inicializan con los sell_rates actuales de Bridge.
--   El cron (cada 10 min) los sobreescribirá con el valor vivo en la próxima ejecución.

INSERT INTO exchange_rates_config (pair, rate, spread_percent, bridge_buy_rate, bridge_sell_rate)
VALUES
  ('USD_MXN', 17.13002,    0.50, 17.30218,    17.13002),
  ('USD_EUR', 0.8572,      0.50,  0.8657,      0.8572),
  ('USD_BRL', 5.074039,    0.50,  5.130161,    5.074039),
  ('USD_COP', 3428.224025, 0.50,  3480.035975, 3428.224025),
  ('USD_GBP', 0.7413,      0.50,  0.7486,      0.7413)
ON CONFLICT (pair) DO NOTHING;
