-- ================================================================
--  Elimina la columna `currency` de la tabla `wallets`.
--
--  Contexto: Bridge crea wallets por chain, no por moneda.
--  Un wallet Solana puede contener USDC, USDT, USDB, PYUSD, EURC
--  simultáneamente. La columna `currency` era un artefacto legacy
--  que siempre contenía el primer token del wallet (USDC) y generaba
--  fallbacks incorrectos en el backend al usarla como source_currency
--  por defecto en transferencias de otros tokens (ej. USDT → Tron).
--
--  Después de este cambio:
--  - Los balances multi-token viven en la tabla `balances` (por user_id + currency).
--  - El backend ya no usa wallet.currency como fallback; todos los flujos
--    requieren source_currency / destination_currency explícito en el DTO
--    o caen a 'usdc' si no se especifica.
-- ================================================================

ALTER TABLE wallets DROP COLUMN IF EXISTS currency;
