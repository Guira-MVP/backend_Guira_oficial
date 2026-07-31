-- `declares_no_qualifying_ubos` nunca fue un campo de Bridge (verificado contra
-- POST /v0/customers en https://apidocs.bridge.xyz/api-reference/customers/create-a-customer
-- y contra la documentacion de KYB): era una valvula de escape 100% interna de
-- Guira para permitir enviar un KYB no-sole_prop con 0 UBOs. El mecanismo real
-- que Bridge exige para ese caso es la atestacion del control person
-- (`attested_ownership_structure_at`, ya obligatoria via el checkbox F5 del
-- wizard), que no depende de esta columna. Se elimina para no mantener un
-- campo sin efecto real en el envio a Bridge.
ALTER TABLE businesses DROP COLUMN IF EXISTS declares_no_qualifying_ubos;
