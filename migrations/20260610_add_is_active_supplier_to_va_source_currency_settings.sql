-- Permite habilitar/deshabilitar por moneda/rail la creación de proveedores fiat
-- (PIX/BRL, Bre-B y CO Bank Transfer/COP, SPEI/MXN, SEPA/EUR, ACH-Wire/USD, Faster Payments/GBP).
-- DEFAULT true preserva el comportamiento actual para las filas existentes.
ALTER TABLE va_source_currency_settings
  ADD COLUMN IF NOT EXISTS is_active_supplier BOOLEAN NOT NULL DEFAULT true;
