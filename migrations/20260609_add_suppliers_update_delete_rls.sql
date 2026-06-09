-- Add UPDATE and DELETE RLS policies for the suppliers table.
-- The backend uses service_role (bypasses RLS), so these policies
-- act as a safety net against direct Supabase client access.
-- Date: 2026-06-09

CREATE POLICY "suppliers: usuario actualiza los suyos"
  ON public.suppliers FOR UPDATE
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "suppliers: usuario elimina los suyos"
  ON public.suppliers FOR DELETE
  USING ((SELECT auth.uid()) = user_id);
