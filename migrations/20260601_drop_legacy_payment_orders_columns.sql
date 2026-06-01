-- ============================================================
-- Migration: drop_legacy_payment_orders_columns
-- Purpose:
--   Eliminar columnas legacy de payment_orders confirmadas sin uso tras
--   auditoría columna-por-columna (0 datos, 0 escritores, 0 lectores):
--
--     1. payin_route_id   → FK a payin_routes nunca poblada. No existe en
--        ningún DTO ni INSERT del backend; solo aparecía como campo opcional
--        en el DTO del frontend que el backend ignora. Arrastra el índice
--        idx_payment_orders_payin_route_id y la FK
--        payment_orders_payin_route_id_fkey (ambos se eliminan en cascada).
--     2. exchange_rate    → Duplicado informativo de exchange_rate_applied.
--        Nunca se escribe; el comprobante PDF y el expediente usan
--        exchange_rate_applied. Los writers llamados "exchange_rate" del
--        backend escriben sobre bridge_transfers, no sobre payment_orders.
--     3. sender_bank_name → Añadida vía MCP sin escritor. Solo se persiste
--        sender_name (depósitos VA).
--     4. deposit_message  → El mensaje/referencia de depósito vive en
--        bridge_transfers y en las virtual accounts, no en payment_orders.
--
--   Verificación previa: sin vistas, funciones, triggers ni políticas RLS
--   que referencien estas columnas. Las 4 tenían 0 valores no nulos.
--
--   Idempotente (IF EXISTS): seguro de re-aplicar en cualquier entorno.
-- Date: 2026-06-01
-- ============================================================

ALTER TABLE payment_orders
  DROP COLUMN IF EXISTS payin_route_id,
  DROP COLUMN IF EXISTS exchange_rate,
  DROP COLUMN IF EXISTS sender_bank_name,
  DROP COLUMN IF EXISTS deposit_message;
