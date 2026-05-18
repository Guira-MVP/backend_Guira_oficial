-- Agregar columna updated_at a bridge_virtual_accounts para soportar el trigger trg_updated_at
ALTER TABLE bridge_virtual_accounts
ADD COLUMN updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
