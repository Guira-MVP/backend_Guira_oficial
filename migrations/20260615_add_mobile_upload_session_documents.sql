-- Tracks the exact document targets and uploads that belong to each mobile
-- session. The public mobile client only reaches this data through NestJS.

CREATE TABLE public.mobile_upload_session_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id uuid NOT NULL REFERENCES public.mobile_upload_tokens(id) ON DELETE CASCADE,
  document_key text NOT NULL,
  document_type text NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('person', 'business', 'director', 'ubo')),
  label text NOT NULL,
  observation text,
  uploaded_document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  uploaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mobile_upload_session_documents_key_unique UNIQUE (token_id, document_key)
);

CREATE INDEX mobile_upload_session_documents_token_idx
  ON public.mobile_upload_session_documents (token_id);

CREATE INDEX mobile_upload_session_documents_uploaded_document_idx
  ON public.mobile_upload_session_documents (uploaded_document_id)
  WHERE uploaded_document_id IS NOT NULL;

ALTER TABLE public.mobile_upload_session_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_full_access ON public.mobile_upload_session_documents
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON public.mobile_upload_session_documents FROM anon, authenticated;
