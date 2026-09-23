-- Limita el bucket de comprobantes a los tipos y tamano que el frontend ya
-- valida (lib/file-validation.ts: JPEG, PNG, WEBP y PDF). Hasta ahora el
-- bucket aceptaba cualquier archivo si alguien subia directo contra Storage.
-- Aplicada en staging como 20260914194225_restrict_payment_receipts_bucket.
update storage.buckets
set allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
    file_size_limit = 20971520
where id = 'payment-receipts';
