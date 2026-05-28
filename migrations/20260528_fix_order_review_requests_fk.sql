-- Fix FK reviewed_by: ON DELETE SET NULL para no bloquear eliminación de admins.
-- Sin esta cláusula el FK default es RESTRICT, lo que impide borrar un usuario
-- que haya revisado al menos una solicitud.

ALTER TABLE order_review_requests
  DROP CONSTRAINT IF EXISTS order_review_requests_reviewed_by_fkey;

ALTER TABLE order_review_requests
  ADD CONSTRAINT order_review_requests_reviewed_by_fkey
    FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;
