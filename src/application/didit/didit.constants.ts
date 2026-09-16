export const DIDIT_ID_VERIFICATION_PATH = '/v3/id-verification/';
export const DIDIT_FACE_MATCH_PATH = '/v3/face-match/';
export const DIDIT_AML_PATH = '/v3/aml/';
export const DIDIT_DATABASE_VALIDATION_PATH = '/v3/database-validation/';
export const DIDIT_PASSIVE_LIVENESS_PATH = '/v3/passive-liveness/';
export const DIDIT_POA_PATH = '/v3/poa/';
export const DIDIT_WALLET_SCREENING_PATH = '/v3/wallet-screening/';

/** Timeout por llamada — las tres son síncronas, ninguna debería superar esto. */
export const DIDIT_TIMEOUT_MS = 30_000;

/**
 * El default de Didit es 30 y su propia documentación lo describe como
 * permisivo. Se sube a 55 para un veto más estricto sin llegar al 60+ que
 * generaría demasiados falsos rechazos en capturas de baja calidad.
 */
export const DIDIT_FACE_MATCH_DECLINE_THRESHOLD = 55;

export const DIDIT_ID_VERIFICATION_MAX_BYTES = 10 * 1024 * 1024;
export const DIDIT_FACE_MATCH_MAX_BYTES = 5 * 1024 * 1024;
/** Liveness acepta las mismas extensiones y el mismo límite que face-match. */
export const DIDIT_LIVENESS_MAX_BYTES = DIDIT_FACE_MATCH_MAX_BYTES;
export const DIDIT_POA_MAX_BYTES = 15 * 1024 * 1024;

/**
 * El default de Didit es 30, igual de permisivo que el de face-match.
 * Se sube por el mismo motivo: un veto más estricto sin caer en el 60+ que
 * generaría demasiados falsos rechazos en capturas de baja calidad.
 */
export const DIDIT_LIVENESS_DECLINE_THRESHOLD = 50;

/** face-match no acepta PDF — solo estos formatos de imagen. */
export const DIDIT_FACE_MATCH_ACCEPTED_MIME = new Set([
  'image/tiff',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/**
 * Mapa ISO 3166-1 alpha-2 → alpha-3, duplicado desde
 * BridgeCustomerService.ALPHA2_TO_ALPHA3 (privado, no exportable).
 * Cubre los países relevantes para Guira. El módulo de Didit necesita el
 * sentido inverso (alpha-3 → alpha-2, ver ALPHA3_TO_ALPHA2 abajo) porque
 * `people.nationality` se guarda en alpha-3 pero el AML de Didit exige
 * alpha-2.
 */
const ALPHA2_TO_ALPHA3: Record<string, string> = {
  AD: 'AND', AE: 'ARE', AF: 'AFG', AG: 'ATG', AI: 'AIA', AL: 'ALB', AM: 'ARM',
  AO: 'AGO', AQ: 'ATA', AR: 'ARG', AS: 'ASM', AT: 'AUT', AU: 'AUS', AW: 'ABW',
  AX: 'ALA', AZ: 'AZE', BA: 'BIH', BB: 'BRB', BD: 'BGD', BE: 'BEL', BF: 'BFA',
  BG: 'BGR', BH: 'BHR', BI: 'BDI', BJ: 'BEN', BL: 'BLM', BM: 'BMU', BN: 'BRN',
  BO: 'BOL', BQ: 'BES', BR: 'BRA', BS: 'BHS', BT: 'BTN', BV: 'BVT', BW: 'BWA',
  BY: 'BLR', BZ: 'BLZ', CA: 'CAN', CC: 'CCK', CD: 'COD', CF: 'CAF', CG: 'COG',
  CH: 'CHE', CI: 'CIV', CK: 'COK', CL: 'CHL', CM: 'CMR', CN: 'CHN', CO: 'COL',
  CR: 'CRI', CU: 'CUB', CV: 'CPV', CW: 'CUW', CX: 'CXR', CY: 'CYP', CZ: 'CZE',
  DE: 'DEU', DJ: 'DJI', DK: 'DNK', DM: 'DMA', DO: 'DOM', DZ: 'DZA', EC: 'ECU',
  EE: 'EST', EG: 'EGY', EH: 'ESH', ER: 'ERI', ES: 'ESP', ET: 'ETH', FI: 'FIN',
  FJ: 'FJI', FK: 'FLK', FM: 'FSM', FO: 'FRO', FR: 'FRA', GA: 'GAB', GB: 'GBR',
  GD: 'GRD', GE: 'GEO', GF: 'GUF', GG: 'GGY', GH: 'GHA', GI: 'GIB', GL: 'GRL',
  GM: 'GMB', GN: 'GIN', GP: 'GLP', GQ: 'GNQ', GR: 'GRC', GS: 'SGS', GT: 'GTM',
  GU: 'GUM', GW: 'GNB', GY: 'GUY', HK: 'HKG', HM: 'HMD', HN: 'HND', HR: 'HRV',
  HT: 'HTI', HU: 'HUN', ID: 'IDN', IE: 'IRL', IL: 'ISR', IM: 'IMN', IN: 'IND',
  IO: 'IOT', IQ: 'IRQ', IR: 'IRN', IS: 'ISL', IT: 'ITA', JE: 'JEY', JM: 'JAM',
  JO: 'JOR', JP: 'JPN', KE: 'KEN', KG: 'KGZ', KH: 'KHM', KI: 'KIR', KM: 'COM',
  KN: 'KNA', KP: 'PRK', KR: 'KOR', KW: 'KWT', KY: 'CYM', KZ: 'KAZ', LA: 'LAO',
  LB: 'LBN', LC: 'LCA', LI: 'LIE', LK: 'LKA', LR: 'LBR', LS: 'LSO', LT: 'LTU',
  LU: 'LUX', LV: 'LVA', LY: 'LBY', MA: 'MAR', MC: 'MCO', MD: 'MDA', ME: 'MNE',
  MF: 'MAF', MG: 'MDG', MH: 'MHL', MK: 'MKD', ML: 'MLI', MM: 'MMR', MN: 'MNG',
  MO: 'MAC', MP: 'MNP', MQ: 'MTQ', MR: 'MRT', MS: 'MSR', MT: 'MLT', MU: 'MUS',
  MV: 'MDV', MW: 'MWI', MX: 'MEX', MY: 'MYS', MZ: 'MOZ', NA: 'NAM', NC: 'NCL',
  NE: 'NER', NF: 'NFK', NG: 'NGA', NI: 'NIC', NL: 'NLD', NO: 'NOR', NP: 'NPL',
  NR: 'NRU', NU: 'NIU', NZ: 'NZL', OM: 'OMN', PA: 'PAN', PE: 'PER', PF: 'PYF',
  PG: 'PNG', PH: 'PHL', PK: 'PAK', PL: 'POL', PM: 'SPM', PN: 'PCN', PR: 'PRI',
  PS: 'PSE', PT: 'PRT', PW: 'PLW', PY: 'PRY', QA: 'QAT', RE: 'REU', RO: 'ROU',
  RS: 'SRB', RU: 'RUS', RW: 'RWA', SA: 'SAU', SB: 'SLB', SC: 'SYC', SD: 'SDN',
  SE: 'SWE', SG: 'SGP', SH: 'SHN', SI: 'SVN', SJ: 'SJM', SK: 'SVK', SL: 'SLE',
  SM: 'SMR', SN: 'SEN', SO: 'SOM', SR: 'SUR', SS: 'SSD', ST: 'STP', SV: 'SLV',
  SX: 'SXM', SY: 'SYR', SZ: 'SWZ', TC: 'TCA', TD: 'TCD', TF: 'ATF', TG: 'TGO',
  TH: 'THA', TJ: 'TJK', TK: 'TKL', TL: 'TLS', TM: 'TKM', TN: 'TUN', TO: 'TON',
  TR: 'TUR', TT: 'TTO', TV: 'TUV', TW: 'TWN', TZ: 'TZA', UA: 'UKR', UG: 'UGA',
  UM: 'UMI', US: 'USA', UY: 'URY', UZ: 'UZB', VA: 'VAT', VC: 'VCT', VE: 'VEN',
  VG: 'VGB', VI: 'VIR', VN: 'VNM', VU: 'VUT', WF: 'WLF', WS: 'WSM', YE: 'YEM',
  YT: 'MYT', ZA: 'ZAF', ZM: 'ZMB', ZW: 'ZWE',
};

function invert(map: Record<string, string>): Record<string, string> {
  const inverted: Record<string, string> = {};
  for (const [alpha2, alpha3] of Object.entries(map)) {
    inverted[alpha3] = alpha2;
  }
  return inverted;
}

/** alpha-3 (como se guarda `people.nationality`) → alpha-2 (como lo exige el AML de Didit). */
export const ALPHA3_TO_ALPHA2: Record<string, string> = invert(ALPHA2_TO_ALPHA3);

/** Tipos de documento de `documents.document_type` para subject_type='person'. */
export const DIDIT_DOC_TYPE_FRONT_PRIORITY = [
  'national_id_front',
  'passport',
  'drivers_license_front',
];
export const DIDIT_DOC_TYPE_BACK_MAP: Record<string, string> = {
  national_id_front: 'national_id_back',
  drivers_license_front: 'drivers_license_back',
};
/** ref_image para face-match: nunca el pasaporte (suele venir en PDF). */
export const DIDIT_FACE_MATCH_REF_PRIORITY = [
  'national_id_front',
  'drivers_license_front',
];
export const DIDIT_SELFIE_DOC_TYPE = 'selfie';
export const DIDIT_POA_DOC_TYPE = 'proof_of_address';

/**
 * Servicio de Database Validation por país (alpha-3 → service_id del
 * catálogo de Didit). Deliberadamente acotado a Bolivia: es el único país
 * con volumen real de usuarios en Guira hoy (14/14 personas de prueba son
 * BOL salvo 1 COL). Añadir un país nuevo es una línea — cuando haya
 * usuarios reales de otro país, se agrega su service_id aquí.
 */
export const DIDIT_DATABASE_VALIDATION_SERVICES: Record<string, string> = {
  BOL: 'bol_cedula',
};

// ── Wallet Screening de beneficiarios cripto ─────────────────────────

/**
 * Red de Guira (`suppliers.bank_details.wallet_network`) → identificador de
 * red de Didit (`blockchain`).
 *
 * Solo 4 de las 6 redes de ALLOWED_NETWORKS tienen cobertura: Didit acepta
 * BTC, LIGHTNING, ETH, LTC, XRP, BCH, DOGE, TRX, SOL, MATIC, BNB, USDT y
 * USDC, así que `base` y `stellar` quedan fuera. Una red sin mapeo NO se
 * envía a Didit (daría 400): el beneficiario se crea con el screening en
 * `Skipped`, igual que se hace con los países sin cobertura de Database
 * Validation en el KYC.
 */
export const DIDIT_WALLET_SCREENING_NETWORKS: Record<string, string> = {
  ethereum: 'ETH',
  solana: 'SOL',
  tron: 'TRX',
  polygon: 'MATIC',
};

/**
 * Clave de `app_settings` que habilita el screening. Apagada (o ausente) el
 * beneficiario se crea sin llamar a Didit — el interruptor que pidió el
 * negocio para poder anular la revisión sin desplegar.
 */
export const WALLET_SCREENING_ENABLED_SETTING_KEY = 'WALLET_SCREENING_ENABLED';

/**
 * Claves del re-screening periódico.
 *
 * `WALLET_RESCREENING_ENABLED` es independiente de la de creación a
 * propósito: son dos decisiones distintas. Se puede querer revisar altas
 * nuevas sin barrer la cartera entera, o al revés durante una auditoría.
 */
export const WALLET_RESCREENING_ENABLED_SETTING_KEY =
  'WALLET_RESCREENING_ENABLED';
export const WALLET_RESCREENING_INTERVAL_SETTING_KEY =
  'WALLET_RESCREENING_INTERVAL_DAYS';
export const WALLET_RESCREENING_BATCH_SETTING_KEY =
  'WALLET_RESCREENING_BATCH_SIZE';

/** Valores por defecto si la clave falta o trae basura. */
export const WALLET_RESCREENING_DEFAULT_INTERVAL_DAYS = 30;
export const WALLET_RESCREENING_DEFAULT_BATCH_SIZE = 25;
