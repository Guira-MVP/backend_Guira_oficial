-- 20260615_tighten_public_bucket_listing_policies.sql
--
-- Auditoría de seguridad Supabase 2026-06-15 — Hallazgo 8.
--
-- avatars, brand-assets y public-assets son buckets con storage.buckets.public
-- = true. Esa bandera ya permite leer cualquier objeto sin RLS via
-- /storage/v1/object/public/<bucket>/<path> (lo que usa getPublicUrl() en el
-- frontend). Las policies *_select_public adicionales (roles={public},
-- qual: bucket_id = '<bucket>') permiten además LISTAR el contenido completo
-- del bucket (supabase.storage.from(bucket).list() / /storage/v1/object/list),
-- exponiendo p.ej. todos los user_id con avatar subido. get_advisors las marca
-- como "Public Bucket Allows Listing" (WARN).
--
-- Ninguna pantalla del frontend usa .list() sobre estos buckets (solo
-- getPublicUrl()), por lo que eliminarlas no afecta la visualización pública
-- de imágenes.

DROP POLICY IF EXISTS avatars_select_public ON storage.objects;
DROP POLICY IF EXISTS brand_assets_select_public ON storage.objects;
DROP POLICY IF EXISTS public_assets_select_public ON storage.objects;
