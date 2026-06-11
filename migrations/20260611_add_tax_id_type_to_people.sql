-- ═══════════════════════════════════════════════════════════════
--  people.tax_id_type
--  Tipo de identificación tributaria seleccionado por el cliente
--  (ej. 'nit', 'rut', 'curp', 'rfc', 'tin'), enviado a Bridge como
--  identifying_information.type junto con people.tax_id.
--  Ver documentacion guira/customers/kyc/Individuos.md.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE people ADD COLUMN IF NOT EXISTS tax_id_type TEXT;
