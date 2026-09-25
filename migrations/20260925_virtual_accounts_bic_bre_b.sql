-- Campos de source_deposit_instructions que Bridge devuelve y no se guardaban:
--   bic       → EUR (SEPA), requerido por el schema VirtualAccountSourceDepositInstructionsEu
--   bre_b_key → COP (Bre-B), requerido por el schema VirtualAccountSourceDepositInstructionsCo
ALTER TABLE public.bridge_virtual_accounts
  ADD COLUMN IF NOT EXISTS bic text,
  ADD COLUMN IF NOT EXISTS bre_b_key text;
