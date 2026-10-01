/**
 * Documento de Guira (documents.document_type) → casilla de Tazapay.
 * Tipos "extended" del changelog 2026 de Tazapay
 * (documentacion tazapay/changelog/2026/extended-document-types-for-entity-submission.md)
 * y casillas del paso Documents del dashboard. Plan KYB §8.
 */

export interface TazapayDocumentSpec {
  /** Casilla lógica (una por documento enviado; un archivo puede ocupar dos). */
  slot: string;
  type: string;
  sub_type: string;
  tag: string;
  description: string;
}

/** Documentos de la empresa (documents.subject_type = 'business'). */
export const BUSINESS_DOCUMENT_SLOTS: Readonly<
  Record<string, TazapayDocumentSpec>
> = {
  business_registration: {
    slot: 'registration',
    type: 'registration_documents',
    sub_type: 'other',
    tag: 'registrationProofDoc',
    description:
      'Business registration proof (commercial registry certificate)',
  },
  incorporation_certificate: {
    slot: 'articles',
    type: 'article_of_incorporation',
    sub_type: 'other',
    tag: 'registrationProofDoc',
    description: 'Articles of incorporation (deed of incorporation and bylaws)',
  },
  proof_of_address: {
    slot: 'operating_address',
    type: 'proof_of_address',
    sub_type: 'other',
    tag: 'AddressProofDoc',
    description: 'Operating address proof',
  },
  ownership_information: {
    slot: 'shareholding',
    type: 'shareholder_registry',
    sub_type: 'other',
    tag: 'beneficialOwnershipDoc',
    description: 'Business shareholding structure',
  },
  // Opcionales de Tazapay: solo se envían si Guira ya los recolectó para Bridge.
  tax_registration: {
    slot: 'additional:tax_registration',
    type: 'other',
    sub_type: 'other',
    tag: 'additionalDocs',
    description: 'Tax registration (NIT)',
  },
  proof_of_nature_of_business: {
    slot: 'additional:nature_of_business',
    type: 'other',
    sub_type: 'other',
    tag: 'additionalDocs',
    description: 'Proof of nature of business',
  },
  flow_of_funds: {
    slot: 'additional:flow_of_funds',
    type: 'other',
    sub_type: 'other',
    tag: 'additionalDocs',
    description: 'Flow of funds',
  },
};

/** Casilla de estructura accionaria cuando se reutiliza el testimonio. */
export const SHAREHOLDING_FROM_INCORPORATION: TazapayDocumentSpec = {
  ...BUSINESS_DOCUMENT_SLOTS.ownership_information,
  slot: 'shareholding',
  description:
    'Business shareholding structure (listed in the deed of incorporation)',
};

const ADDRESS_SUBTYPE_DESCRIPTION: Record<string, string> = {
  utility_bill: 'Recent utility bill',
  bank_statement: 'Bank statement',
  lease_agreement: 'Lease agreement',
};

/** Documentos de una persona (documents.subject_type = 'director' | 'ubo'). */
export function personDocumentSpec(
  documentType: string,
  documentSubtype?: string | null,
): TazapayDocumentSpec | null {
  switch (documentType) {
    case 'passport':
      return {
        slot: 'identity_front',
        type: 'proof_of_identity',
        sub_type: 'passport',
        tag: 'identityProofTypeFrontDoc',
        description: 'Passport',
      };
    case 'national_id_front':
      return {
        slot: 'identity_front',
        type: 'proof_of_identity',
        sub_type: 'national_id',
        tag: 'identityProofTypeFrontDoc',
        description: 'National ID (front)',
      };
    case 'national_id_back':
      return {
        slot: 'identity_back',
        type: 'proof_of_identity',
        sub_type: 'national_id',
        tag: 'identityProofTypeBackDoc',
        description: 'National ID (back)',
      };
    case 'drivers_license_front':
      return {
        slot: 'identity_front',
        type: 'proof_of_identity',
        sub_type: 'driving_license',
        tag: 'identityProofTypeFrontDoc',
        description: "Driver's license (front)",
      };
    case 'drivers_license_back':
      return {
        slot: 'identity_back',
        type: 'proof_of_identity',
        sub_type: 'driving_license',
        tag: 'identityProofTypeBackDoc',
        description: "Driver's license (back)",
      };
    case 'proof_of_address':
      return {
        slot: 'address',
        type: 'proof_of_address',
        sub_type: 'other',
        tag: 'AddressProofDoc',
        description:
          ADDRESS_SUBTYPE_DESCRIPTION[documentSubtype ?? ''] ?? 'Address proof',
      };
    default:
      // selfie y demás: Tazapay no tiene casilla para ellos.
      return null;
  }
}

/** Faltantes obligatorios de Tazapay para una empresa (dashboard, paso Documents). */
export function missingBusinessDocuments(params: {
  entityType: string;
  available: Set<string>;
  ownershipInIncorporationDoc: boolean;
  shareholdingSameAsRegistration: boolean;
}): string[] {
  const missing: string[] = [];
  const has = (t: string) => params.available.has(t);
  const isSoleProp = params.entityType === 'sole_prop';
  if (!has('business_registration'))
    missing.push('Matrícula de comercio (Business registration proof)');
  if (!isSoleProp && !has('incorporation_certificate'))
    missing.push('Testimonio de constitución (Articles of Incorporation)');
  if (!has('proof_of_address'))
    missing.push(
      'Comprobante de domicilio operativo (Operating address proof)',
    );
  const shareholdingCovered =
    isSoleProp ||
    params.shareholdingSameAsRegistration ||
    has('ownership_information') ||
    (params.ownershipInIncorporationDoc && has('incorporation_certificate'));
  if (!shareholdingCovered)
    missing.push('Estructura accionaria (Business shareholding structure)');
  return missing;
}
