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

export interface DiditKeyPersonResult {
  id: string;
  role: 'director' | 'ubo';
  name: string;
  position?: string;
  percentage?: number;
  aml: DiditAmlResult | null;
  id_verification?: DiditIdVerificationResult | null;
  face_match?: DiditFaceMatchResult | null;
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
  company_aml?: DiditAmlResult | null;
  key_people?: DiditKeyPersonResult[];
  errors: Array<{ check: string; message: string }>;
}
