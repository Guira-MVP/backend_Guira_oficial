-- Vincula el proveedor a su liquidation address de Bridge (ej. "la_abc123")
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS bridge_liquidation_address_id TEXT;

-- Permite guardar wallet address de destino para liquidaciones crypto → crypto
ALTER TABLE bridge_liquidation_addresses
  ADD COLUMN IF NOT EXISTS destination_address TEXT;
