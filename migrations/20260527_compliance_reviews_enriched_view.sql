-- 20260527_compliance_reviews_enriched_view.sql
--
-- Elimina el patrón N+1 de listOpenReviews.
-- Antes: 1 query inicial + 3-4 queries secuenciales por cada review abierto.
-- Ahora: 1 sola query con JOINs — el motor SQL resuelve todo en un solo plan.

CREATE OR REPLACE VIEW compliance_reviews_enriched AS
SELECT
  -- Campos base del review
  cr.id,
  cr.subject_type,
  cr.subject_id,
  cr.assigned_to,
  cr.status,
  cr.priority,
  cr.due_date,
  cr.opened_at,
  cr.closed_at,

  -- user_id resuelto desde la aplicación correspondiente
  COALESCE(kyc.user_id, kyb.requester_user_id)                       AS user_id,

  -- Tipo de onboarding derivado del subject_type
  CASE
    WHEN cr.subject_type = 'kyb_applications' THEN 'company'
    ELSE 'personal'
  END                                                                 AS type,

  -- Estado real de la aplicación (no el del review que es siempre 'open')
  COALESCE(kyc.status, kyb.status, cr.status)                        AS application_status,

  -- updated_at de la aplicación con fallback a opened_at del review
  COALESCE(kyc.updated_at, kyb.updated_at, cr.opened_at)             AS updated_at,

  -- Observaciones del expediente (escritas por staff o Bridge)
  COALESCE(kyc.observations, kyb.observations)                       AS observations,

  -- Datos del perfil del usuario (aplanados — el servicio los reconstruye)
  p.email                                                            AS profile_email,
  p.full_name                                                        AS profile_full_name,

  -- Nombre legal del negocio (solo para KYB, null para KYC)
  b.legal_name                                                       AS profile_business_name

FROM compliance_reviews cr

LEFT JOIN kyc_applications kyc
  ON cr.subject_type = 'kyc_applications'
 AND cr.subject_id   = kyc.id

LEFT JOIN kyb_applications kyb
  ON cr.subject_type = 'kyb_applications'
 AND cr.subject_id   = kyb.id

LEFT JOIN profiles p
  ON p.id = COALESCE(kyc.user_id, kyb.requester_user_id)

-- JOIN preciso por business_id (1:1 con la aplicación KYB) — evita duplicados
-- si un usuario tiene más de una empresa en la tabla businesses
LEFT JOIN businesses b
  ON b.id            = kyb.business_id
 AND cr.subject_type = 'kyb_applications';
