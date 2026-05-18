-- ============================================================
-- Migration: create_client_bank_accounts_table
-- Purpose: Store client bank account details for bridge_wallet_to_fiat_bo flow
-- Date: 2025-04-14
-- ============================================================

-- 1. Crear tabla client_bank_accounts
CREATE TABLE IF NOT EXISTS client_bank_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    
    -- Datos bancarios
    bank_name TEXT NOT NULL,
    account_number TEXT NOT NULL,
    account_holder TEXT NOT NULL,
    
    -- Metadata
    currency TEXT NOT NULL DEFAULT 'BOB',
    country TEXT NOT NULL DEFAULT 'BO',
    account_type TEXT DEFAULT 'savings',      -- savings, checking
    is_primary BOOLEAN DEFAULT TRUE,
    is_verified BOOLEAN DEFAULT FALSE,
    
    -- Flujo de aprobación para cambios
    status TEXT NOT NULL DEFAULT 'approved',   -- approved, pending_approval
    pending_changes JSONB DEFAULT NULL,        -- Cambios propuestos pendientes de aprobación del staff
    
    -- Auditoría
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Índices
CREATE INDEX IF NOT EXISTS idx_client_bank_accounts_user_id 
    ON client_bank_accounts(user_id);

CREATE INDEX IF NOT EXISTS idx_client_bank_accounts_status 
    ON client_bank_accounts(status);

-- 3. RLS
ALTER TABLE client_bank_accounts ENABLE ROW LEVEL SECURITY;

-- El usuario solo puede ver/modificar sus propias cuentas
CREATE POLICY "users_manage_own_bank_accounts" 
    ON client_bank_accounts 
    FOR ALL 
    USING (auth.uid() = user_id);

-- Staff/admin pueden ver todas las cuentas (para revisión de cambios)
CREATE POLICY "staff_view_all_bank_accounts" 
    ON client_bank_accounts 
    FOR SELECT 
    USING (
        EXISTS (
            SELECT 1 FROM profiles 
            WHERE id = auth.uid() 
            AND role IN ('staff', 'admin', 'super_admin')
        )
    );

-- Staff/admin pueden actualizar todas las cuentas (para aprobar/rechazar cambios)
CREATE POLICY "staff_update_all_bank_accounts" 
    ON client_bank_accounts 
    FOR UPDATE 
    USING (
        EXISTS (
            SELECT 1 FROM profiles 
            WHERE id = auth.uid() 
            AND role IN ('staff', 'admin', 'super_admin')
        )
    );

-- 4. Agregar columna de trazabilidad en payment_orders
ALTER TABLE payment_orders 
    ADD COLUMN IF NOT EXISTS client_bank_account_id UUID REFERENCES client_bank_accounts(id);

-- 5. Comentarios de documentación
COMMENT ON TABLE client_bank_accounts IS 
    'Cuentas bancarias del cliente para retiros BO. Datos propios de Guira (no se envían a Bridge).';
COMMENT ON COLUMN client_bank_accounts.status IS 
    'Estado de la cuenta: approved = activa, pending_approval = cambios pendientes de revisión del staff.';
COMMENT ON COLUMN client_bank_accounts.pending_changes IS 
    'JSON con los cambios propuestos por el cliente, pendientes de aprobación del staff.';
COMMENT ON COLUMN payment_orders.client_bank_account_id IS 
    'FK a la cuenta bancaria del cliente usada en el retiro (snapshot para trazabilidad).';
