export type DiditCheckStatus = 'Approved' | 'Declined' | 'In Review' | 'Skipped' | 'Error';

export interface DiditFile {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

// ── Respuestas crudas de Didit (solo los campos que se usan) ──────────

export interface DiditIdVerificationRaw {
  request_id?: string;
  id_verification: {
    status: DiditCheckStatus;
    document_number?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    date_of_birth?: string | null;
    nationality?: string | null;
    warnings?: Array<{ code?: string; risk?: string; description?: string }>;
  };
}

export interface DiditFaceMatchRaw {
  request_id?: string;
  face_match: {
    status: DiditCheckStatus;
    score?: number | null;
    warnings?: Array<{ code?: string; risk?: string; description?: string }>;
  };
}

export interface DiditAmlRaw {
  request_id?: string;
  aml: {
    status: DiditCheckStatus;
    score?: number | null;
    total_hits?: number;
    hits?: Array<{ name?: string; type?: string; source?: string }>;
    warnings?: Array<{ code?: string; risk?: string; description?: string }>;
  };
}

export interface DiditDatabaseValidationRaw {
  request_id?: string;
  database_validation: {
    status: DiditCheckStatus;
    match_type?: 'full_match' | 'partial_match' | 'no_match' | null;
    validations?: Array<{ outcome_code?: string; service_id?: string }>;
  };
}

export interface DiditLivenessRaw {
  request_id?: string;
  liveness: {
    status: DiditCheckStatus;
    score?: number | null;
    warnings?: Array<{ code?: string; risk?: string; description?: string }>;
  };
}

export interface DiditPoaRaw {
  request_id?: string;
  poa: {
    status: DiditCheckStatus;
    issuer?: string | null;
    name_on_document?: string | null;
    warnings?: Array<{ code?: string; risk?: string; description?: string }>;
  };
}

export type DiditWalletScreeningSeverity =
  | 'UNKNOWN'
  | 'LOW'
  | 'MEDIUM'
  | 'HIGH'
  | 'CRITICAL';

export interface DiditWalletScreeningRiskFactor {
  category?: string;
  label?: string;
  entity_name?: string | null;
  exposure_type?: string;
  percentage?: number;
  is_high_risk?: boolean;
  description?: string;
}

export interface DiditWalletScreeningRaw {
  provider?: string;
  risk_score?: number;
  severity?: DiditWalletScreeningSeverity;
  /** `SCREENED` | `PENDING` | `ERROR` — el proveedor puede no resolver en el momento. */
  status?: string;
  summary?: string;
  wallet_address?: string;
  blockchain?: string;
  sanctions_hit?: boolean;
  dominant_risk_category?: string | null;
  risk_factors?: DiditWalletScreeningRiskFactor[];
}

// ── Veredicto consolidado, persistido en kyc_applications.screening.didit ──

export interface DiditVerdictWarning {
  code?: string;
  description?: string;
}

export interface DiditIdVerificationResult {
  status: DiditCheckStatus;
  request_id?: string;
  document_number_last4?: string;
  first_name?: string | null;
  last_name?: string | null;
  date_of_birth?: string | null;
  nationality?: string | null;
  warnings: DiditVerdictWarning[];
  mismatches: string[];
}

export interface DiditFaceMatchResult {
  status: DiditCheckStatus;
  request_id?: string;
  score?: number | null;
  warnings: DiditVerdictWarning[];
  skip_reason?: string;
}

export interface DiditAmlResult {
  status: DiditCheckStatus;
  request_id?: string;
  score?: number | null;
  total_hits?: number;
  hits_summary: Array<{ name?: string; type?: string; source?: string }>;
  warnings: DiditVerdictWarning[];
}

export interface DiditDatabaseValidationResult {
  status: DiditCheckStatus;
  request_id?: string;
  match_type?: 'full_match' | 'partial_match' | 'no_match' | null;
  warnings: DiditVerdictWarning[];
  skip_reason?: string;
}

export interface DiditLivenessResult {
  status: DiditCheckStatus;
  request_id?: string;
  score?: number | null;
  warnings: DiditVerdictWarning[];
  skip_reason?: string;
}

export interface DiditPoaResult {
  status: DiditCheckStatus;
  request_id?: string;
  issuer?: string | null;
  warnings: DiditVerdictWarning[];
  skip_reason?: string;
}

export interface DiditKeyPersonResult {
  id: string;
  role: 'director' | 'ubo';
  name: string;
  position?: string;
  percentage?: number;
  aml: DiditAmlResult | null;
  id_verification?: DiditIdVerificationResult | null;
  face_match?: DiditFaceMatchResult | null;
  database_validation?: DiditDatabaseValidationResult | null;
  liveness?: DiditLivenessResult | null;
}

export type DiditOverall = 'approved' | 'declined' | 'needs_review' | 'error';

export interface DiditVerdict {
  schema_version: 1;
  overall: DiditOverall;
  run_at: string;
  run_by: string;
  run_count: number;
  threshold_used: number;
  application_type?: 'kyc' | 'kyb';
  id_verification: DiditIdVerificationResult | null;
  face_match: DiditFaceMatchResult | null;
  aml: DiditAmlResult | null;
  database_validation?: DiditDatabaseValidationResult | null;
  liveness?: DiditLivenessResult | null;
  proof_of_address?: DiditPoaResult | null;
  company_aml?: DiditAmlResult | null;
  company_proof_of_address?: DiditPoaResult | null;
  key_people?: DiditKeyPersonResult[];
  errors: Array<{ check: string; message: string }>;
}

// ── Veredicto de Wallet Screening, persistido en suppliers.bank_details ──

/**
 * Qué hacer con el beneficiario según el resultado:
 * - `allow`  → crear sin más (limpio, sin cobertura, deshabilitado o error).
 * - `flag`   → crear, marcar y avisar al cliente (riesgo medio/alto).
 * - `block`  → no crear (sanciones o riesgo crítico).
 */
export type WalletScreeningDecision = 'allow' | 'flag' | 'block';

/**
 * Lo que se guarda en `suppliers.bank_details.wallet_screening`. Mantiene el
 * `risk_score` crudo además de la banda porque `severity: UNKNOWN` es la banda
 * más baja (0-9), no un "sin datos": un score 1-9 es una señal real y no debe
 * presentarse como limpio.
 */
export interface WalletScreeningVerdict {
  schema_version: 1;
  status: DiditCheckStatus;
  decision: WalletScreeningDecision;
  screened_at: string;
  provider?: string;
  blockchain?: string;
  risk_score?: number;
  severity?: DiditWalletScreeningSeverity;
  sanctions_hit?: boolean;
  dominant_risk_category?: string | null;
  summary?: string;
  risk_factors?: DiditWalletScreeningRiskFactor[];
  /** Por qué no se screeneó: red sin cobertura, revisión apagada, sin API key. */
  skip_reason?: string;
  /** Mensaje del fallo cuando `status === 'Error'`. */
  error_message?: string;
  /**
   * Sello que pone la RPC `claim_suppliers_for_rescreening` al reclamar el
   * beneficiario para un ciclo de re-screening. Caduca en una hora para que
   * un tick muerto no deje la fila bloqueada. Lo escribe Postgres, no el
   * backend.
   */
  rescreen_claimed_at?: string;
}

/** Estado de cumplimiento de un beneficiario (`suppliers.compliance_status`). */
export type SupplierComplianceStatus = 'pending_review' | 'blocked';

/** Resultado de aplicar un re-screening a un beneficiario concreto. */
export interface RescreeningOutcome {
  supplierId: string;
  supplierName: string;
  userId: string;
  verdict: WalletScreeningVerdict;
  /** Estado resultante; `null` si el beneficiario sigue limpio. */
  complianceStatus: SupplierComplianceStatus | null;
}
