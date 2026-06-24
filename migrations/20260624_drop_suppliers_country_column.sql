-- La columna `country` en suppliers nunca fue utilizada en el código.
-- Toda referencia a "country" en proveedores viene de bank_details.address.country
-- o de bank_details.iban_country, nunca de esta columna de nivel superior.
ALTER TABLE suppliers DROP COLUMN IF EXISTS country;
