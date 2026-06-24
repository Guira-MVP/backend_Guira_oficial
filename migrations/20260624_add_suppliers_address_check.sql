-- Cuando bank_details contiene un objeto address (no null), Bridge requiere
-- al menos street_line_1, city y country (ISO alpha-3). Este constraint hace
-- que ese invariante esté enforced en DB y no solo en la capa de aplicación.
-- address null o ausente pasan sin problema (SEPA, crypto, Bre-B, etc.).
ALTER TABLE suppliers ADD CONSTRAINT suppliers_address_minimum_fields
CHECK (
  bank_details->'address' IS NULL
  OR bank_details->>'address' = 'null'
  OR (
    bank_details->'address'->>'street_line_1' IS NOT NULL
    AND bank_details->'address'->>'city' IS NOT NULL
    AND bank_details->'address'->>'country' IS NOT NULL
  )
);
