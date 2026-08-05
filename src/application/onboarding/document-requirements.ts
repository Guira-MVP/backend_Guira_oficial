/**
 * Tipos de documento de identidad que Bridge exige según `id_type`.
 * Espejo del mapeo en frontend_guira_staff/lib/document-requirements.ts —
 * usado en backend para validar, antes de enviar a Bridge, que cada
 * director/UBO tiene un documento de identidad activo.
 */
export function getRequiredIdentityDocTypes(idType: string | undefined): string[] {
  switch (idType) {
    case 'passport':
      return ['passport'];
    case 'national_id':
      return ['national_id_front', 'national_id_back'];
    case 'drivers_license':
      return ['drivers_license_front', 'drivers_license_back'];
    default:
      return idType ? [idType] : [];
  }
}
