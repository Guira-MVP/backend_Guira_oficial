-- Bridge exige `associated_persons[].residential_address.subdivision` para ciertos países
-- (confirmado en vivo contra Bridge: "associated_persons[0].residential_address.subdivision
-- must be set for provided country", cuenta administracion@guiracorp.com, 2026-07-29 20:29:56).
-- business_directors nunca tuvo columna `state`/subdivision — a diferencia de business_ubos,
-- que sí la tiene (columna huérfana desde antes, nunca poblada). Se agrega aquí para que el
-- representante legal pueda declarar su departamento/provincia y bridge-customer.service.ts
-- pueda enviarlo como `subdivision` en su residential_address.
alter table business_directors
  add column if not exists state text;
