/**
 * Tipos de documento de identidad que Bridge exige según `id_type`.
 * Espejo del mapeo en frontend_guira_staff/lib/document-requirements.ts —
 * usado en backend para validar, antes de enviar a Bridge, que cada
 * director/UBO tiene un documento de identidad activo.
 */
/**
 * Nombres legibles de cada documento. El error de expediente incompleto se le
 * muestra al cliente final, así que no puede hablarle en códigos internos
 * ("falta: national_id_front").
 */
const IDENTITY_DOC_LABELS: Record<string, string> = {
  passport: 'Página de información del pasaporte',
  national_id_front: 'Anverso de la cédula de identidad',
  national_id_back: 'Reverso de la cédula de identidad',
  drivers_license_front: 'Anverso de la licencia de conducir',
  drivers_license_back: 'Reverso de la licencia de conducir',
  selfie: 'Fotografía selfie',
};

export function labelForIdentityDocType(docType: string): string {
  return IDENTITY_DOC_LABELS[docType] ?? docType;
}

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
