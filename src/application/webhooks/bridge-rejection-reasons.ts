/**
 * bridge-rejection-reasons.ts
 *
 * Traduce los `developer_reason` que Bridge envía en `rejection_reasons[]`
 * (customer.updated.status_transitioned con status=rejected) a un texto
 * accionable para el staff y a un mensaje seguro para compartir con el cliente.
 *
 * Fuente: documentacion guira/Rejection reasons/Rejection reasons.md
 * (tabla oficial de Bridge: developer_reason ↔ reason).
 *
 * `developer_reason` es de uso interno (puede contener detalle sensible de
 * por qué se rechazó). `reason` es el texto que Bridge autoriza a mostrar
 * directamente al cliente — aquí además se traduce a español.
 */

export interface BridgeRejectionReason {
  /** Texto técnico exacto que envía Bridge (clave de búsqueda). */
  developerReason: string;
  /** Texto en inglés que Bridge autoriza compartir con el cliente. */
  reason: string;
  /** Traducción al español, lista para mostrar al cliente. */
  reasonEs: string;
}

const RAW_TABLE: Array<[string, string, string]> = [
  ['ID cannot be verified against third-party databases', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Inconsistent or incomplete information.', 'Inconsistent or incomplete information.', 'La información proporcionada es inconsistente o está incompleta.'],
  ['Cannot validate user age', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Missing or incomplete barcode on the ID.', 'Cannot validate ID -- upload a clear photo of the full ID', 'No pudimos validar tu documento de identidad. Sube una foto clara donde se vea el documento completo.'],
  ['Inconsistent information in the barcode.', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Submission is blurry.', 'Cannot validate ID - upload photo of ID is clear', 'No pudimos validar tu documento de identidad. Sube una foto nítida y sin reflejos del documento.'],
  ['Inconsistent ID format', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Compromised ID detected', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['ID from disallowed country.', 'Cannot accept provided ID', 'No podemos aceptar el tipo de documento que enviaste para tu país.'],
  ['Incorrect ID type selected.', 'Incorrect ID type selected.', 'Se seleccionó un tipo de documento incorrecto.'],
  ['Same side submitted as both front and back.', 'Same side submitted as both front and back.', 'Enviaste la misma cara del documento como frente y como reverso.'],
  ['Electronic replica detected.', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['No government ID found in submission.', 'No government ID found in submission.', 'No se encontró un documento de identidad oficial en el archivo enviado.'],
  ['ID is expired.', 'ID is expired.', 'El documento de identidad está vencido.'],
  ['Missing required ID details.', 'Cannot validate ID -- upload a clear photo of the full ID', 'No pudimos validar tu documento de identidad. Sube una foto clara donde se vea el documento completo.'],
  ['Inconsistent details in extraction.', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Likely fabrication detected.', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Glare detected in the submission.', 'Cannot validate ID -- upload a clear photo of the full ID', 'No pudimos validar tu documento de identidad. Sube una foto clara donde se vea el documento completo.'],
  ['Identity cannot be verified', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Inconsistent details with previous submission.', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Inconsistent details between submissions.', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Machine readable zone not detected', 'Cannot validate ID -- upload a clear photo of the full ID', 'No pudimos validar tu documento de identidad. Sube una foto clara donde se vea el documento completo.'],
  ['Inconsistent machine readable zone', 'Cannot validate ID -- upload a clear photo of the full ID', 'No pudimos validar tu documento de identidad. Sube una foto clara donde se vea el documento completo.'],
  ['ID number format inconsistency.', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Paper copy detected.', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['PO box address detected.', 'PO box address detected.', 'La dirección enviada corresponde a una casilla postal, no es válida como domicilio.'],
  ['Blurry face portrait.', 'Cannot validate ID -- upload a clear photo of the full ID', 'No pudimos validar tu documento de identidad. Sube una foto clara donde se vea el documento completo, incluido el rostro.'],
  ['No face portrait found in the submission.', 'Cannot validate ID -- upload a clear photo of the full ID', 'No pudimos validar tu documento de identidad. La foto enviada no muestra el rostro/retrato del documento — sube una foto clara donde se vea el documento completo.'],
  ['Face portrait matches a public figure.', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Not a U.S. REAL ID.', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['ID details and face match previous submission.', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Different faces in ID and selfie.', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Tampering detected.', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Submission cannot be processed.', 'Submission cannot be processed.', 'El archivo enviado no pudo ser procesado. Intenta con otro formato o calidad de imagen.'],
  ['Dates on the ID are invalid.', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Identity cannot be verified against third-party databases', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Person is deceased.', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Document could not be verified', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Unsupported country', 'Your region is not supported', 'Tu país o región no está soportado actualmente por el proveedor de verificación.'],
  ['No government ID detected', 'Cannot validate ID -- upload a clear photo of the full ID', 'No pudimos validar tu documento de identidad. Sube una foto clara donde se vea el documento completo.'],
  ['No database check was performed', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Prohibited state/province', 'Your region is not supported', 'Tu país o región no está soportado actualmente por el proveedor de verificación.'],
  ['Prohibited country', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Potential elder abuse', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Potential PEP', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Customer information could not be verified', 'Your information could not be verified', 'No pudimos verificar tu información con las bases de datos oficiales.'],
  ['Unsupported state/province', 'Your region is not supported', 'Tu país o región no está soportado actualmente por el proveedor de verificación.'],
  ['Missing or invalid proof of address', 'Missing or invalid proof of address', 'El comprobante de domicilio falta o no es válido.'],
];

export const BRIDGE_REJECTION_REASONS: BridgeRejectionReason[] = RAW_TABLE.map(
  ([developerReason, reason, reasonEs]) => ({ developerReason, reason, reasonEs }),
);

const BY_DEVELOPER_REASON = new Map<string, BridgeRejectionReason>(
  BRIDGE_REJECTION_REASONS.map((entry) => [
    entry.developerReason.trim().toLowerCase(),
    entry,
  ]),
);

/**
 * Busca la traducción de un `developer_reason` (o, como fallback, de un
 * `reason`) enviado por Bridge. Devuelve `undefined` si Bridge envió un
 * texto no catalogado en la documentación (p. ej. un código nuevo de
 * endorsement como `government_id_verification_failed`).
 */
export function describeBridgeReason(
  text: string,
): BridgeRejectionReason | undefined {
  const key = text.trim().toLowerCase();
  return BY_DEVELOPER_REASON.get(key);
}

/**
 * Detalle estructurado de un issue de rechazo, ya resuelto contra el
 * catálogo de Bridge. `known: false` indica que el texto no está en la
 * documentación (se muestra tal cual llegó, sin traducir).
 */
export interface BridgeIssueDetail {
  code: string;
  developerReason: string;
  reason: string | null;
  reasonEs: string | null;
  known: boolean;
}

export function buildBridgeIssueDetails(issues: string[]): BridgeIssueDetail[] {
  return issues.map((issue) => {
    const match = describeBridgeReason(issue);
    return {
      code: issue,
      developerReason: issue,
      reason: match?.reason ?? null,
      reasonEs: match?.reasonEs ?? null,
      known: Boolean(match),
    };
  });
}
