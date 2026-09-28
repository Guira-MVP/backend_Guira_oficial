-- Onboarding asistido por staff.
--
-- El staff recibe por WhatsApp los datos y documentos del cliente y llena el
-- MISMO borrador (onboarding_drafts) que usaría el cliente. El cliente luego
-- revisa, acepta los términos de Bridge y envía con el flujo normal.
--
--   assisted_by        último miembro del staff que escribió en el borrador.
--   assisted_ready_at  cuándo el staff lo marcó "listo para el cliente";
--                      el wizard del cliente muestra el aviso y lo lleva al
--                      último paso. Se limpia cuando el cliente envía (el
--                      borrador se borra en markSubmitted).
--   documents.uploaded_by  quién subió el archivo (NULL = el propio cliente,
--                      filas anteriores a esta migración incluidas).
--
-- kyc/kyb_applications.source no tiene CHECK: 'staff_assisted' se guarda sin
-- cambios de esquema.
ALTER TABLE public.onboarding_drafts
  ADD COLUMN IF NOT EXISTS assisted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.onboarding_drafts
  ADD COLUMN IF NOT EXISTS assisted_ready_at timestamptz;

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS uploaded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Número de WhatsApp del botón de ayuda del panel del cliente. Solo dígitos
-- con código de país (formato wa.me). Vacío = el botón no se muestra.
INSERT INTO public.app_settings (key, value, type, description, is_public)
VALUES
  ('SUPPORT_WHATSAPP_NUMBER', '', 'string',
   'Número de WhatsApp de soporte para el onboarding (solo dígitos con código de país, ej: 59171234567). Vacío oculta el botón.',
   true),
  ('SUPPORT_WHATSAPP_MESSAGE', 'Hola, necesito ayuda para completar el registro de mi empresa en Guira.', 'string',
   'Mensaje prellenado al abrir el chat de WhatsApp de soporte.',
   true)
ON CONFLICT (key) DO NOTHING;
