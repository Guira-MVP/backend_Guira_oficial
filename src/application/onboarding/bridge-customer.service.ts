import {
  Injectable,
  Inject,
  BadGatewayException,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { BridgeApiClient } from '../bridge/bridge-api.client';

/**
 * Servicio interno para registrar clientes en Bridge API tras la aprobación de KYC/KYB.
 * Este servicio NO se expone directamente a clientes — es llamado por ComplianceActionsService
 * o por un admin tras aprobar un compliance_review.
 *
 * Usa BridgeApiClient centralizado para todas las llamadas HTTP a Bridge.
 *
 * AUDIT FIX (2025-04-05):
 *  H01 – signed_agreement_id se lee de kyc_applications/kyb_applications y se incluye en payload
 *  H02 – identifying_information[] se construye como array de objetos con imágenes base64
 *  H03 – associated_persons[] (directors + UBOs) se incluye en payload KYB
 *  H04 – documents[] se descarga de Storage y se convierten a base64 para Bridge
 *  H05 – country ISO alpha-2 → alpha-3 convertido en todos los campos de dirección
 *  H06 – campo renombrado: address → residential_address (KYC), registered_address (KYB)
 *  H07 – business_name → business_legal_name
 *  H08 – doing_business_as_name → business_trade_name
 *  H09 – nationality también convertido a alpha-3
 *  H14 – state → subdivision en objetos address
 */
@Injectable()
export class BridgeCustomerService {
  private readonly logger = new Logger(BridgeCustomerService.name);

  /** Mapa ISO 3166-1 alpha-2 → alpha-3. Cubre los países relevantes para Guira. */
  private static readonly ALPHA2_TO_ALPHA3: Record<string, string> = {
    AD: 'AND',
    AE: 'ARE',
    AF: 'AFG',
    AG: 'ATG',
    AI: 'AIA',
    AL: 'ALB',
    AM: 'ARM',
    AO: 'AGO',
    AQ: 'ATA',
    AR: 'ARG',
    AS: 'ASM',
    AT: 'AUT',
    AU: 'AUS',
    AW: 'ABW',
    AX: 'ALA',
    AZ: 'AZE',
    BA: 'BIH',
    BB: 'BRB',
    BD: 'BGD',
    BE: 'BEL',
    BF: 'BFA',
    BG: 'BGR',
    BH: 'BHR',
    BI: 'BDI',
    BJ: 'BEN',
    BL: 'BLM',
    BM: 'BMU',
    BN: 'BRN',
    BO: 'BOL',
    BQ: 'BES',
    BR: 'BRA',
    BS: 'BHS',
    BT: 'BTN',
    BV: 'BVT',
    BW: 'BWA',
    BY: 'BLR',
    BZ: 'BLZ',
    CA: 'CAN',
    CC: 'CCK',
    CD: 'COD',
    CF: 'CAF',
    CG: 'COG',
    CH: 'CHE',
    CI: 'CIV',
    CK: 'COK',
    CL: 'CHL',
    CM: 'CMR',
    CN: 'CHN',
    CO: 'COL',
    CR: 'CRI',
    CU: 'CUB',
    CV: 'CPV',
    CW: 'CUW',
    CX: 'CXR',
    CY: 'CYP',
    CZ: 'CZE',
    DE: 'DEU',
    DJ: 'DJI',
    DK: 'DNK',
    DM: 'DMA',
    DO: 'DOM',
    DZ: 'DZA',
    EC: 'ECU',
    EE: 'EST',
    EG: 'EGY',
    EH: 'ESH',
    ER: 'ERI',
    ES: 'ESP',
    ET: 'ETH',
    FI: 'FIN',
    FJ: 'FJI',
    FK: 'FLK',
    FM: 'FSM',
    FO: 'FRO',
    FR: 'FRA',
    GA: 'GAB',
    GB: 'GBR',
    GD: 'GRD',
    GE: 'GEO',
    GF: 'GUF',
    GG: 'GGY',
    GH: 'GHA',
    GI: 'GIB',
    GL: 'GRL',
    GM: 'GMB',
    GN: 'GIN',
    GP: 'GLP',
    GQ: 'GNQ',
    GR: 'GRC',
    GS: 'SGS',
    GT: 'GTM',
    GU: 'GUM',
    GW: 'GNB',
    GY: 'GUY',
    HK: 'HKG',
    HM: 'HMD',
    HN: 'HND',
    HR: 'HRV',
    HT: 'HTI',
    HU: 'HUN',
    ID: 'IDN',
    IE: 'IRL',
    IL: 'ISR',
    IM: 'IMN',
    IN: 'IND',
    IO: 'IOT',
    IQ: 'IRQ',
    IR: 'IRN',
    IS: 'ISL',
    IT: 'ITA',
    JE: 'JEY',
    JM: 'JAM',
    JO: 'JOR',
    JP: 'JPN',
    KE: 'KEN',
    KG: 'KGZ',
    KH: 'KHM',
    KI: 'KIR',
    KM: 'COM',
    KN: 'KNA',
    KP: 'PRK',
    KR: 'KOR',
    KW: 'KWT',
    KY: 'CYM',
    KZ: 'KAZ',
    LA: 'LAO',
    LB: 'LBN',
    LC: 'LCA',
    LI: 'LIE',
    LK: 'LKA',
    LR: 'LBR',
    LS: 'LSO',
    LT: 'LTU',
    LU: 'LUX',
    LV: 'LVA',
    LY: 'LBY',
    MA: 'MAR',
    MC: 'MCO',
    MD: 'MDA',
    ME: 'MNE',
    MF: 'MAF',
    MG: 'MDG',
    MH: 'MHL',
    MK: 'MKD',
    ML: 'MLI',
    MM: 'MMR',
    MN: 'MNG',
    MO: 'MAC',
    MP: 'MNP',
    MQ: 'MTQ',
    MR: 'MRT',
    MS: 'MSR',
    MT: 'MLT',
    MU: 'MUS',
    MV: 'MDV',
    MW: 'MWI',
    MX: 'MEX',
    MY: 'MYS',
    MZ: 'MOZ',
    NA: 'NAM',
    NC: 'NCL',
    NE: 'NER',
    NF: 'NFK',
    NG: 'NGA',
    NI: 'NIC',
    NL: 'NLD',
    NO: 'NOR',
    NP: 'NPL',
    NR: 'NRU',
    NU: 'NIU',
    NZ: 'NZL',
    OM: 'OMN',
    PA: 'PAN',
    PE: 'PER',
    PF: 'PYF',
    PG: 'PNG',
    PH: 'PHL',
    PK: 'PAK',
    PL: 'POL',
    PM: 'SPM',
    PN: 'PCN',
    PR: 'PRI',
    PS: 'PSE',
    PT: 'PRT',
    PW: 'PLW',
    PY: 'PRY',
    QA: 'QAT',
    RE: 'REU',
    RO: 'ROU',
    RS: 'SRB',
    RU: 'RUS',
    RW: 'RWA',
    SA: 'SAU',
    SB: 'SLB',
    SC: 'SYC',
    SD: 'SDN',
    SE: 'SWE',
    SG: 'SGP',
    SH: 'SHN',
    SI: 'SVN',
    SJ: 'SJM',
    SK: 'SVK',
    SL: 'SLE',
    SM: 'SMR',
    SN: 'SEN',
    SO: 'SOM',
    SR: 'SUR',
    SS: 'SSD',
    ST: 'STP',
    SV: 'SLV',
    SX: 'SXM',
    SY: 'SYR',
    SZ: 'SWZ',
    TC: 'TCA',
    TD: 'TCD',
    TF: 'ATF',
    TG: 'TGO',
    TH: 'THA',
    TJ: 'TJK',
    TK: 'TKL',
    TL: 'TLS',
    TM: 'TKM',
    TN: 'TUN',
    TO: 'TON',
    TR: 'TUR',
    TT: 'TTO',
    TV: 'TUV',
    TW: 'TWN',
    TZ: 'TZA',
    UA: 'UKR',
    UG: 'UGA',
    UM: 'UMI',
    US: 'USA',
    UY: 'URY',
    UZ: 'UZB',
    VA: 'VAT',
    VC: 'VCT',
    VE: 'VEN',
    VG: 'VGB',
    VI: 'VIR',
    VN: 'VNM',
    VU: 'VUT',
    WF: 'WLF',
    WS: 'WSM',
    YE: 'YEM',
    YT: 'MYT',
    ZA: 'ZAF',
    ZM: 'ZMB',
    ZW: 'ZWE',
  };

  /** Mapa de document_type interno → purposes de Bridge.
   *  Actualizado P0-A: solo propósitos válidos del enum Bridge.
   *  Documentos de identidad (passport, national_id, drivers_license, selfie) NO van en documents[],
   *  van dentro de identifying_information[].
   *  FIX-W1: añadido proof_of_nature_of_business — requerido por Bridge cuando no hay primary_website.
   */
  private static readonly DOC_TYPE_TO_BRIDGE_PURPOSE: Record<string, string> = {
    proof_of_address: 'proof_of_address',
    utility_bill: 'proof_of_address',
    bank_statement: 'proof_of_address',
    source_of_funds: 'proof_of_source_of_funds',
    flow_of_funds: 'flow_of_funds', // Required by Bridge when conducts_money_services_using_bridge=true
    tax_certificate: 'proof_of_tax_identification',
    tax_registration: 'proof_of_tax_identification', // NIT/RUT/RFC document uploaded in KYB step 5
    business_formation: 'business_formation',
    incorporation_certificate: 'business_formation',
    ownership_information: 'ownership_information',
    operating_agreement: 'ownership_information', // Bridge enum has no 'operating_agreement'; closest is ownership_information
    proof_of_nature_of_business: 'proof_of_nature_of_business',
    other: 'other',
  };

  /** Tipos de documento que son de identidad y NO deben ir en documents[]. */
  private static readonly IDENTITY_DOC_TYPES = new Set([
    'passport',
    'national_id',
    'national_id_front',
    'national_id_back',
    'drivers_license',
    'drivers_license_front',
    'drivers_license_back',
    'selfie',
  ]);

  /**
   * Tax ID type por país (individual). ISO 3166-1 alpha-3 → Bridge identifying_information type.
   * Referencia: https://apidocs.bridge.xyz/docs/individual-tax-identification-numbers-by-country
   */
  private static readonly COUNTRY_TAX_ID_INDIVIDUAL: Record<string, string> = {
    ARG: 'cuil',
    BOL: 'nit',
    BRA: 'cpf',
    CHL: 'rut',
    COL: 'other', // Cédula de Ciudadanía no está en el enum de Bridge
    CRI: 'other', // Cédula física no está en el enum de Bridge
    DOM: 'other', // Cédula de identidad dominicana no está en el enum
    ECU: 'ruc',
    SLV: 'nit',
    GTM: 'nit',
    GUY: 'tin',
    HND: 'rtn',
    MEX: 'curp',
    PAN: 'ruc',
    PRY: 'ruc',
    PER: 'other', // DNI peruano (individual) no está en el enum
    SUR: 'other',
    URY: 'rut',
  };

  /**
   * Tax ID type por país (empresa). ISO 3166-1 alpha-3 → Bridge identifying_information type.
   * Referencia: https://apidocs.bridge.xyz/docs/business-tax-identification-numbers-by-country
   */
  private static readonly COUNTRY_TAX_ID_BUSINESS: Record<string, string> = {
    ARG: 'cuit',
    BOL: 'nit',
    BRA: 'cnpj',
    CHL: 'rut',
    COL: 'nit',
    CRI: 'cedula_juridica',
    DOM: 'rnc',
    ECU: 'ruc',
    SLV: 'nit',
    GTM: 'nit',
    GUY: 'tin',
    HND: 'rtn',
    MEX: 'rfc',
    PAN: 'ruc',
    PRY: 'ruc',
    PER: 'ruc',
    SUR: 'other',
    URY: 'rut',
  };


  private static readonly STORAGE_BUCKET = 'kyc-documents';

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly bridgeApiClient: BridgeApiClient,
  ) {}

  /**
   * Registra un usuario como Customer en Bridge API.
   * Construye el payload desde people (KYC) o businesses (KYB).
   * Retorna el bridge_customer_id asignado.
   */
  async registerCustomerInBridge(userId: string): Promise<string> {
    if (!this.bridgeApiClient.isConfigured) {
      this.logger.warn(
        'BRIDGE_API_KEY no configurada — registro Bridge omitido',
      );
      return 'bridge_pending_api_key';
    }

    // 1. Obtener datos del usuario
    const { data: profile, error: profileErr } = await this.supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (profileErr || !profile) {
      throw new NotFoundException(`Perfil ${userId} no encontrado`);
    }

    // Si ya tiene bridge_customer_id, actualizar en Bridge en lugar de crear uno nuevo
    if (profile.bridge_customer_id) {
      return this.updateCustomerInBridge(userId, profile.bridge_customer_id as string);
    }

    // 2. Determinar tipo de cliente (persona o empresa)
    const { data: person } = await this.supabase
      .from('people')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    const { data: business } = await this.supabase
      .from('businesses')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    let customerPayload: Record<string, unknown>;

    if (person) {
      // Obtener signed_agreement_id desde la kyc_application más reciente (H01)
      const { data: kycApp } = await this.supabase
        .from('kyc_applications')
        .select('tos_contract_id, id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      customerPayload = await this.buildIndividualPayload(
        person,
        profile,
        userId,
        kycApp?.tos_contract_id ?? null,
      );
    } else if (business) {
      // Obtener signed_agreement_id desde la kyb_application más reciente (H01)
      const { data: kybApp } = await this.supabase
        .from('kyb_applications')
        .select('tos_contract_id, id')
        .eq('business_id', business.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      customerPayload = await this.buildBusinessPayload(
        business,
        profile,
        userId,
        kybApp?.tos_contract_id ?? null,
      );
    } else {
      throw new NotFoundException(
        'No se encontraron datos personales ni de empresa para este usuario',
      );
    }

    // 3. Llamar Bridge API usando BridgeApiClient centralizado
    const idempotencyKey = `register-customer-${userId}`;
    let bridgeCustomer: Record<string, unknown>;

    try {
      bridgeCustomer = await this.bridgeApiClient.post<Record<string, unknown>>(
        '/v0/customers',
        customerPayload,
        idempotencyKey,
      );
    } catch (err) {
      await this.logActivity(
        userId,
        'BRIDGE_CUSTOMER_REGISTRATION_FAILED',
        `Bridge rechazó registro: ${(err as Error).message}`,
      );
      throw err;
    }

    const customerId = bridgeCustomer.id as string;
    if (!customerId) {
      throw new BadGatewayException('Bridge no retornó un customer_id válido');
    }

    // 4. Guardar bridge_customer_id en profiles
    // NO ponemos 'approved' aquí — la aprobación final viene del webhook de Bridge.
    // NO inicializamos wallets aquí — eso se hará cuando Bridge confirme vía webhook.
    await this.supabase
      .from('profiles')
      .update({
        bridge_customer_id: customerId,
        // onboarding_status se mantiene en 'pending_bridge' (seteado por sendToBridgeSubject)
      })
      .eq('id', userId);

    // 4b. Guardar el payload enviado a Bridge para diagnóstico futuro
    await this.supabase
      .from('kyc_applications')
      .update({
        bridge_request_payload: customerPayload,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .in('status', ['sent_to_bridge', 'submitted', 'under_review', 'pending']);

    // 5. Log de éxito (registro enviado, no aprobación)
    await this.logActivity(
      userId,
      'BRIDGE_CUSTOMER_REGISTERED',
      `Customer registrado en Bridge: ${customerId}. Esperando verificación vía webhook.`,
    );

    this.logger.log(
      `Bridge customer ${customerId} creado para usuario ${userId} — pendiente de verificación webhook`,
    );

    return customerId;
  }

  /**
   * Actualiza un Customer existente en Bridge API via PUT.
   * Usado cuando el cliente ya tiene bridge_customer_id (segunda revisión, correcciones, etc.).
   */
  async updateCustomerInBridge(userId: string, bridgeCustomerId: string): Promise<string> {
    const { data: profile, error: profileErr } = await this.supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (profileErr || !profile) {
      throw new NotFoundException(`Perfil ${userId} no encontrado`);
    }

    const { data: person } = await this.supabase
      .from('people')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    const { data: business } = await this.supabase
      .from('businesses')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    let customerPayload: Record<string, unknown>;

    if (person) {
      const { data: kycApp } = await this.supabase
        .from('kyc_applications')
        .select('tos_contract_id, id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      customerPayload = await this.buildIndividualPayload(
        person,
        profile,
        userId,
        kycApp?.tos_contract_id ?? null,
      );
    } else if (business) {
      const { data: kybApp } = await this.supabase
        .from('kyb_applications')
        .select('tos_contract_id, id')
        .eq('business_id', business.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      customerPayload = await this.buildBusinessPayload(
        business,
        profile,
        userId,
        kybApp?.tos_contract_id ?? null,
      );
    } else {
      throw new NotFoundException(
        'No se encontraron datos personales ni de empresa para este usuario',
      );
    }

    try {
      await this.bridgeApiClient.put(
        `/v0/customers/${bridgeCustomerId}`,
        customerPayload,
      );
    } catch (err) {
      await this.logActivity(
        userId,
        'BRIDGE_CUSTOMER_UPDATE_FAILED',
        `Bridge rechazó actualización: ${(err as Error).message}`,
      );
      throw err;
    }

    await this.supabase
      .from('kyc_applications')
      .update({
        bridge_request_payload: customerPayload,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .in('status', ['sent_to_bridge', 'submitted', 'under_review', 'pending']);

    await this.logActivity(
      userId,
      'BRIDGE_CUSTOMER_UPDATED',
      `Customer actualizado en Bridge: ${bridgeCustomerId}`,
    );

    this.logger.log(
      `Bridge customer ${bridgeCustomerId} actualizado para usuario ${userId}`,
    );

    return bridgeCustomerId;
  }

  // ───────────────────────────────────────
  //  Payload Builders — alineados con Bridge API
  // ───────────────────────────────────────

  /**
   * Construye el payload para un customer individual (KYC).
   * Campos alineados con Bridge API POST /v0/customers.
   *
   * Correcciones aplicadas:
   *  H01 – signed_agreement_id incluido
   *  H02 – identifying_information[] construido como array de objetos
   *  H04 – documents[] construido como array con base64
   *  H05 – country convertido a ISO alpha-3
   *  H06 – residential_address (no address)
   *  H09 – nationality convertido a ISO alpha-3
   *  H14 – subdivision (no state)
   *  P1  – employment_status y expected_monthly_payments_usd incluidos
   */
  private async buildIndividualPayload(
    person: Record<string, unknown>,
    profile: Record<string, unknown>,
    userId: string,
    tosContractId: string | null,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      type: 'individual',
      first_name: person.first_name,
      last_name: person.last_name,
      email: (person.email as string) ?? (profile.email as string),
      birth_date: person.date_of_birth, // Bridge key: birth_date (not date_of_birth)
      phone: person.phone ?? undefined,
      residential_address: this.buildAddress({
        // H06: residential_address
        address1: person.address1 as string,
        address2: person.address2 as string | undefined,
        city: person.city as string,
        state: person.state as string | undefined,
        postal_code: person.postal_code as string | undefined,
        country: person.country as string,
      }),
    };

    // Middle name (optional Bridge field)
    if (person.middle_name) {
      payload.middle_name = person.middle_name;
    }

    // Tax ID
    // Moved to identifying_information according to Bridge spec
    // if (person.tax_id) {
    //   payload.tax_identification_number = person.tax_id;
    // }

    // Nationality — H05/H09: convert to alpha-3
    if (person.nationality) {
      payload.nationality = this.toAlpha3(person.nationality as string);
    }

    // Signed Agreement (ToS) — H01
    if (tosContractId) {
      payload.signed_agreement_id = tosContractId;
    }

    // Identifying information [] — H02
    const identifyingInfo = await this.buildIdentifyingInformation(
      person,
      person.country as string,
      userId,
      'person',
    );
    if (identifyingInfo.length > 0) {
      payload.identifying_information = identifyingInfo;
    }

    // Documents [] — H04 (P0-A: uses purposes[]/file, excludes identity docs)
    const documents = await this.buildDocumentsArray(userId, 'person');
    if (documents.length > 0) {
      payload.documents = documents;
    }

    // Source of funds & account purpose
    if (person.source_of_funds) {
      payload.source_of_funds = person.source_of_funds;
    }
    if (person.account_purpose) {
      payload.account_purpose = person.account_purpose;
    }
    // P1-A: account_purpose_other required when account_purpose = 'other'
    if (person.account_purpose === 'other' && person.account_purpose_other) {
      payload.account_purpose_other = person.account_purpose_other;
    }

    // P1: High-risk / enhanced due diligence fields
    if (person.employment_status) {
      payload.employment_status = person.employment_status;
    }
    if (person.expected_monthly_payments_usd) {
      payload.expected_monthly_payments_usd =
        person.expected_monthly_payments_usd;
    }
    // AUDIT FIX — most_recent_occupation: alphanumeric code required for high-risk/restricted countries
    if (person.most_recent_occupation) {
      payload.most_recent_occupation = person.most_recent_occupation;
    }
    if (person.acting_as_intermediary !== undefined) {
      payload.acting_as_intermediary = person.acting_as_intermediary;
    }
    payload.client_reference_id = userId;

    return payload;
  }

  /**
   * Construye el payload para un customer business (KYB).
   * Campos alineados con Bridge API POST /v0/customers.
   *
   * Correcciones aplicadas:
   *  H01 – signed_agreement_id incluido
   *  H03 – associated_persons[] construido desde business_directors + business_ubos
   *  H04 – documents[] construido como array con base64
   *  H05 – country convertido a ISO alpha-3
   *  H06 – registered_address (no address)
   *  H07 – business_legal_name (no business_name)
   *  H08 – business_trade_name (no doing_business_as_name)
   *  H11 – business_type mapeado desde entity_type interno a enum de Bridge
   *  H14 – subdivision (no state)
   *  P1  – estimated_annual_revenue_usd y high_risk_activities incluidos
   *  P2  – physical_address incluida desde columnas physical_address*
   */
  private async buildBusinessPayload(
    business: Record<string, unknown>,
    profile: Record<string, unknown>,
    userId: string,
    tosContractId: string | null,
  ): Promise<Record<string, unknown>> {
    const businessCountryAlpha3 = this.toAlpha3(business.country as string);
    const payload: Record<string, unknown> = {
      type: 'business',
      business_legal_name: business.legal_name, // H07: business_legal_name
      email: (business.email as string) ?? (profile.email as string),
      is_dao: business.is_dao ?? false, // P3-A: Use actual value from DTO, default false
      registered_address: this.buildAddress({
        // H06: registered_address
        address1: business.address1 as string,
        address2: business.address2 as string | undefined,
        city: business.city as string,
        state: business.state as string | undefined,
        postal_code: business.postal_code as string | undefined,
        country: business.country as string,
      }),
    };

    // P3-B: Transliteration — Bridge requires transliterated_business_legal_name
    // when the name contains characters outside Latin-1 range.
    const legalName = business.legal_name as string;
    if (legalName && /[^\x20-\x7E\u00C0-\u00FF]/.test(legalName)) {
      payload.transliterated_business_legal_name = legalName
        .normalize('NFD')
        .replace(/[^\x20-\x7E\u00C0-\u00FF]/g, '');
    }

    // Trade name — H08: business_trade_name
    if (business.trade_name) {
      payload.business_trade_name = business.trade_name;
    }

    // Entity type: BusinessTypeEnum values already match Bridge enum directly
    if (business.entity_type) {
      payload.business_type = business.entity_type;
    }

    if (business.website) {
      payload.primary_website = business.website;
    } else {
      // FIX-W1: Bridge rejects KYB without primary_website unless a proof_of_nature_of_business document is provided.
      this.logger.warn(
        `Negocio ${business.id} no tiene website. Bridge requerirá un documento proof_of_nature_of_business.`,
      );
    }

    if (business.other_websites && (business.other_websites as string[]).length > 0) {
      payload.other_websites = business.other_websites;
    }

    if (business.phone) {
      payload.phone = business.phone;
    }

    if (business.business_description) {
      payload.business_description = business.business_description;
    }

    // P1-B: business_industry as array of NAICS codes
    if (business.business_industry) {
      payload.business_industry = Array.isArray(business.business_industry)
        ? business.business_industry
        : [business.business_industry];
    }

    if (business.account_purpose) {
      payload.account_purpose = business.account_purpose;
    }
    // P1-A: account_purpose_other required when account_purpose = 'other'
    if (
      business.account_purpose === 'other' &&
      business.account_purpose_other
    ) {
      payload.account_purpose_other = business.account_purpose_other;
    }

    if (business.source_of_funds) {
      payload.source_of_funds = business.source_of_funds;
    }

    if (business.conducts_money_services !== undefined) {
      payload.conducts_money_services = business.conducts_money_services;

      if (business.conducts_money_services) {
        if (!business.conducts_money_services_description) {
          throw new BadRequestException(
            'conducts_money_services_description es requerido cuando conducts_money_services=true',
          );
        }
        payload.conducts_money_services_description =
          business.conducts_money_services_description;
      }
    }

    if (business.uses_bridge_for_money_services !== undefined) {
      payload.conducts_money_services_using_bridge =
        business.uses_bridge_for_money_services;
    }

    if (business.compliance_explanation) {
      payload.compliance_screening_explanation =
        business.compliance_explanation;
    }

    // P1: High-risk / enhanced due diligence fields
    if (business.estimated_annual_revenue_usd) {
      payload.estimated_annual_revenue_usd =
        business.estimated_annual_revenue_usd;
    }
    if (
      business.high_risk_activities &&
      (business.high_risk_activities as unknown[]).length > 0
    ) {
      payload.high_risk_activities = business.high_risk_activities;
      const hasRealRisk = (business.high_risk_activities as string[]).some(
        (a) => a !== 'none_of_the_above',
      );
      if (hasRealRisk) {
        if (!business.high_risk_activities_explanation) {
          throw new BadRequestException(
            'high_risk_activities_explanation es requerido cuando se declaran actividades de alto riesgo distintas de none_of_the_above',
          );
        }
        payload.high_risk_activities_explanation =
          business.high_risk_activities_explanation;
      }
    }

    // FIX N-04: acting_as_intermediary — required for high-risk customers
    if (business.acting_as_intermediary !== undefined) {
      payload.acting_as_intermediary = business.acting_as_intermediary;
    }

    if (business.operates_in_prohibited_countries !== undefined) {
      payload.operates_in_prohibited_countries =
        business.operates_in_prohibited_countries;
    }

    // FIX N-03: expected_monthly_payments_usd for business is an integer (not string enum)
    if (
      business.expected_monthly_payments_usd !== undefined &&
      business.expected_monthly_payments_usd !== null
    ) {
      payload.expected_monthly_payments_usd = Number(
        business.expected_monthly_payments_usd,
      );
    }

    if (business.source_of_funds_description) {
      payload.source_of_funds_description =
        business.source_of_funds_description;
    }

    // P2: Physical address — solo si street_line_1, city y country están presentes
    // (Bridge requiere street_line_1 minLength:4; evitar enviar dirección incompleta)
    if (
      business.physical_address1 &&
      (business.physical_address1 as string).trim().length >= 4 &&
      business.physical_city &&
      business.physical_country
    ) {
      payload.physical_address = this.buildAddress({
        address1: business.physical_address1 as string,
        address2: business.physical_address2 as string | undefined,
        city: business.physical_city as string,
        state: business.physical_state as string | undefined,
        postal_code: business.physical_postal_code as string | undefined,
        country: business.physical_country as string,
      });
    }

    // Signed Agreement (ToS) — H01
    if (tosContractId) {
      payload.signed_agreement_id = tosContractId;
    }

    // Identifying information — Tax ID con tipo específico por país
    if (business.tax_id) {
      const taxIdType =
        BridgeCustomerService.COUNTRY_TAX_ID_BUSINESS[businessCountryAlpha3] ??
        'other';
      const taxIdEntry: Record<string, unknown> = {
        type: taxIdType,
        issuing_country: businessCountryAlpha3,
        number: business.tax_id,
      };
      if (taxIdType === 'other') {
        taxIdEntry.description = 'Tax Identification Number';
      }
      payload.identifying_information = [taxIdEntry];
    }

    // Associated Persons (directors + UBOs) — H03
    const fallbackEmail =
      (business.email as string) ?? (profile.email as string);
    const associatedPersons = await this.buildAssociatedPersons(
      business.id as string,
      fallbackEmail,
      business, // P0-E: pass business for residential_address fallback
      userId,
    );
    if (associatedPersons.length > 0) {
      payload.associated_persons = associatedPersons;
    }

    // Documents — H04
    const documents = await this.buildDocumentsArray(userId, 'business');
    if (documents.length > 0) {
      payload.documents = documents;
    }

    payload.client_reference_id = userId;

    return payload;
  }

  // ───────────────────────────────────────
  //  Address Builder
  // ───────────────────────────────────────

  private static readonly BOLIVIA_SUBDIVISION_MAP: Record<string, string> = {
    // Single-letter codes (pass-through)
    b: 'B',
    c: 'C',
    h: 'H',
    l: 'L',
    n: 'N',
    o: 'O',
    p: 'P',
    s: 'S',
    t: 'T',
    // ISO 3166-2 with prefix (BO-X)
    'bo-b': 'B',
    'bo-c': 'C',
    'bo-h': 'H',
    'bo-l': 'L',
    'bo-n': 'N',
    'bo-o': 'O',
    'bo-p': 'P',
    'bo-s': 'S',
    'bo-t': 'T',
    // Spanish department names
    'el beni': 'B',
    beni: 'B',
    cochabamba: 'C',
    chuquisaca: 'H',
    sucre: 'H',
    'la paz': 'L',
    pando: 'N',
    oruro: 'O',
    potosí: 'P',
    potosi: 'P',
    'santa cruz': 'S',
    tarija: 'T',
  };

  private normalizeSubdivision(state: string, country: string): string {
    const alpha3 = this.toAlpha3(country);
    if (alpha3 !== 'BOL') return state;
    const code =
      BridgeCustomerService.BOLIVIA_SUBDIVISION_MAP[state.trim().toLowerCase()];
    return code ?? state;
  }

  /**
   * Construye un objeto Address compatible con Bridge API.
   * H05: country convertido a ISO alpha-3.
   * H14: state → subdivision.
   */
  private buildAddress(fields: {
    address1: string;
    address2?: string;
    city: string;
    state?: string;
    postal_code?: string;
    country: string;
  }): Record<string, unknown> {
    const address: Record<string, unknown> = {
      street_line_1: fields.address1,
      city: fields.city,
      country: this.toAlpha3(fields.country), // H05: alpha-3
    };

    if (fields.address2) address.street_line_2 = fields.address2;
    if (fields.state)
      address.subdivision = this.normalizeSubdivision(
        fields.state,
        fields.country,
      ); // H14: subdivision
    if (fields.postal_code) address.postal_code = fields.postal_code;

    // Remove empty strings
    Object.keys(address).forEach((k) => {
      if (address[k] === '' || address[k] === undefined) delete address[k];
    });

    return address;
  }

  // ───────────────────────────────────────
  //  Identifying Information Builder — H02
  // ───────────────────────────────────────

  /**
   * Construye el array identifying_information[] que Bridge requiere.
   * Cada elemento tiene: type, issuing_country, number, expiration.
   * La imagen (image_front/image_back) se descarga de Supabase Storage.
   */
  private async buildIdentifyingInformation(
    entity: Record<string, unknown>,
    issuingCountry: string,
    userId: string,
    subjectType: string,
    subjectId?: string,
  ): Promise<Record<string, unknown>[]> {
    const result: Record<string, unknown>[] = [];
    const countryAlpha3 = this.toAlpha3(issuingCountry);

    // Documento de identidad primario
    if (entity.id_type && entity.id_number) {
      const bridgeIdType = this.mapIdType(entity.id_type as string);
      const item: Record<string, unknown> = {
        type: bridgeIdType,
        issuing_country: countryAlpha3,
        number: entity.id_number,
      };

      if (entity.id_expiry_date) {
        item.expiration = entity.id_expiry_date; // P0-B: Bridge uses 'expiration', not 'expiration_date'
      }

      // Fetch images for identity document
      let query = this.supabase
        .from('documents')
        .select('id, document_type, storage_path, mime_type, created_at')
        .eq('user_id', userId)
        .eq('subject_type', subjectType)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

      if (subjectId) {
        query = query.eq('subject_id', subjectId);
      }

      const { data: rawDocs } = await query;
      const docs: any[] = [];
      if (rawDocs) {
        const typeMap = new Set<string>();
        for (const d of rawDocs) {
          if (!typeMap.has(d.document_type)) {
            typeMap.add(d.document_type);
            docs.push(d);
          }
        }
      }

      if (docs && docs.length > 0) {
        for (const doc of docs) {
          // Si es el documento acorde al tipo de ID
          if (
            BridgeCustomerService.IDENTITY_DOC_TYPES.has(doc.document_type) &&
            ((bridgeIdType === 'passport' &&
              doc.document_type === 'passport') ||
              (bridgeIdType === 'national_id' &&
                doc.document_type.startsWith('national_id')) ||
              (bridgeIdType === 'drivers_license' &&
                doc.document_type.startsWith('drivers_license')))
          ) {
            const base64Content = await this.downloadDocumentAsBase64(
              doc.storage_path,
              doc.mime_type,
            );
            if (base64Content) {
              if (doc.document_type.includes('back')) {
                item.image_back = base64Content;
              } else {
                item.image_front = base64Content;
              }
            }
          }
        }
      }

      // BUG4-FIX: Bridge requires image_front for government ID types
      if (!item.image_front) {
        this.logger.warn(
          `[buildIdentifyingInformation] image_front ausente para ${entity.id_type as string} ` +
          `(subject_type=${subjectType}, subject_id=${subjectId ?? 'none'}). ` +
          `Bridge puede rechazar el payload sin imagen del documento.`,
        );
      }

      result.push(item);
    }

    // P0-D: Tax ID — tipo específico por país según spec Bridge
    if (entity.tax_id) {
      const taxIdType =
        BridgeCustomerService.COUNTRY_TAX_ID_INDIVIDUAL[countryAlpha3] ??
        'other';
      const taxIdEntry: Record<string, unknown> = {
        type: taxIdType,
        issuing_country: countryAlpha3,
        number: entity.tax_id,
      };
      if (taxIdType === 'other') {
        taxIdEntry.description = 'Tax Identification Number';
      }
      result.push(taxIdEntry);
    }

    return result;
  }

  /**
   * Helper para descargar y convertir documentos a base64 Data-URI
   */
  private async downloadDocumentAsBase64(
    storagePath: string,
    mimeType: string,
  ): Promise<string | null> {
    const { data: fileData, error } = await this.supabase.storage
      .from(BridgeCustomerService.STORAGE_BUCKET)
      .download(storagePath);

    if (error || !fileData) {
      this.logger.warn(`No se pudo descargar documento: ${error?.message}`);
      return null;
    }

    const buffer = Buffer.from(await fileData.arrayBuffer());
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  }

  // ───────────────────────────────────────
  //  Documents Builder — H04
  // ───────────────────────────────────────

  /**
   * Lee los documentos del usuario desde la tabla `documents`,
   * descarga cada archivo de Supabase Storage, convierte a base64
   * y retorna el array en el formato que Bridge espera.
   */
  private async buildDocumentsArray(
    userId: string,
    subjectType: string,
    subjectId?: string,
  ): Promise<Record<string, unknown>[]> {
    let query = this.supabase
      .from('documents')
      .select('id, document_type, storage_path, mime_type, created_at')
      .eq('user_id', userId)
      .eq('subject_type', subjectType)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (subjectId) {
      query = query.eq('subject_id', subjectId);
    }

    const { data: rawDocs, error } = await query;
    const docs: any[] = [];
    if (rawDocs && !error) {
      const typeMap = new Set<string>();
      for (const d of rawDocs) {
        if (!typeMap.has(d.document_type)) {
          typeMap.add(d.document_type);
          docs.push(d);
        }
      }
    }

    if (error || !docs || docs.length === 0) return [];

    const result: Record<string, unknown>[] = [];

    for (const doc of docs) {
      // P0-A: Identity document types go in identifying_information[], not documents[]
      if (BridgeCustomerService.IDENTITY_DOC_TYPES.has(doc.document_type)) {
        continue;
      }

      try {
        const base64Content = await this.downloadDocumentAsBase64(
          doc.storage_path,
          doc.mime_type,
        );
        if (!base64Content) continue;

        const bridgePurpose =
          BridgeCustomerService.DOC_TYPE_TO_BRIDGE_PURPOSE[doc.document_type] ??
          'other';

        // P0-A: Bridge requires { purposes: string[], file: string }
        const item: Record<string, unknown> = {
          purposes: [bridgePurpose], // P0-A: array, not singular string
          file: base64Content, // P0-A: 'file', not 'data'
        };

        if (bridgePurpose === 'other') {
          item.description = `Document of type ${doc.document_type}`;
        }

        result.push(item);
      } catch (err) {
        this.logger.warn(`Error procesando documento ${doc.id}: ${err}`);
      }
    }

    return result;
  }

  // ───────────────────────────────────────
  //  Associated Persons Builder — H03
  // ───────────────────────────────────────

  /**
   * Lee directores y UBOs desde la BD y construye el array
   * associated_persons[] que Bridge requiere para KYB.
   * H12: has_control y has_ownership son inferidos de las tablas.
   * P0-E: residential_address always included (fallback to business registered address).
   */
  private async buildAssociatedPersons(
    businessId: string,
    fallbackEmail: string,
    business: Record<string, unknown>,
    userId: string,
  ): Promise<Record<string, unknown>[]> {
    const persons: Record<string, unknown>[] = [];

    // Helper: build residential_address with fallback to business address
    const buildPersonAddress = (
      entity: Record<string, unknown>,
    ): Record<string, unknown> => {
      const hasOwnAddress = entity.address1 && entity.city && entity.country;
      if (hasOwnAddress) {
        return this.buildAddress({
          address1: entity.address1 as string,
          city: entity.city as string,
          country: entity.country as string,
        });
      }
      // P0-E: Fallback to business registered address
      if (business && business.address1 && business.city && business.country) {
        return this.buildAddress({
          address1: business.address1 as string,
          city: business.city as string,
          country: business.country as string,
        });
      }
      throw new BadRequestException(
        `La persona (${(entity as Record<string, unknown>).first_name ?? ''} ${(entity as Record<string, unknown>).last_name ?? ''}) no tiene dirección residencial y el negocio tampoco tiene dirección registrada. Bridge requiere residential_address para cada associated_person.`,
      );
    };

    // Directores
    const { data: directors } = await this.supabase
      .from('business_directors')
      .select('*')
      .eq('business_id', businessId);

    if (directors) {
      for (const dir of directors) {
        const person: Record<string, unknown> = {
          first_name: dir.first_name,
          last_name: dir.last_name,
          has_control: true, // H12: director implica control
          has_ownership: false,
          is_signer: dir.is_signer ?? false,
          is_director: true,
          // P0-E: residential_address always present
          residential_address: buildPersonAddress(dir),
        };

        if (dir.email || fallbackEmail) {
          person.email = dir.email || fallbackEmail;
        }
        if (dir.phone) person.phone = dir.phone;
        if (dir.date_of_birth) person.birth_date = dir.date_of_birth;
        if (dir.position) person.title = dir.position; // position → title

        if (dir.nationality) {
          person.nationalities = [this.toAlpha3(dir.nationality as string)];
        }

        // Identifying information
        const idInfo = await this.buildIdentifyingInformation(
          dir,
          (dir.country as string) ?? '',
          userId,
          'director',
          dir.id as string,
        );
        if (idInfo.length > 0) person.identifying_information = idInfo;

        // FIX-AP: Documents for each associated person (IndividualDocuments)
        const dirDocs = await this.buildDocumentsArray(userId, 'director', dir.id as string);
        if (dirDocs.length > 0) person.documents = dirDocs;

        persons.push(person);
      }
    }

    // UBOs
    const { data: ubos } = await this.supabase
      .from('business_ubos')
      .select('*')
      .eq('business_id', businessId);

    if (ubos) {
      for (const ubo of ubos) {
        const person: Record<string, unknown> = {
          first_name: ubo.first_name,
          last_name: ubo.last_name,
          has_ownership: true, // H12: UBO implica ownership
          has_control: ubo.has_control ?? false,
          is_signer: ubo.is_signer ?? false,
        };

        if (ubo.ownership_percent !== undefined) {
          person.ownership_percentage = ubo.ownership_percent; // ownership_percent → ownership_percentage
        }

        if (ubo.email) person.email = ubo.email;
        if (ubo.phone) person.phone = ubo.phone;
        if (ubo.date_of_birth) person.birth_date = ubo.date_of_birth;

        if (ubo.nationality) {
          person.nationalities = [this.toAlpha3(ubo.nationality as string)];
        }

        // P0-E: residential_address always present
        person.residential_address = buildPersonAddress(ubo);

        // Bridge requires `title` when has_control is true (FinCEN Control Prong)
        if (person.has_control) {
          if (!ubo.position) {
            throw new BadRequestException(
              `El UBO ${ubo.first_name} ${ubo.last_name} tiene has_control=true pero no tiene cargo (position). Bridge requiere el campo title para UBOs con control.`,
            );
          }
          person.title = ubo.position;
        }

        // Identifying information
        const idInfo = await this.buildIdentifyingInformation(
          ubo,
          (ubo.country as string) ?? '',
          userId,
          'ubo',
          ubo.id as string,
        );
        if (idInfo.length > 0) person.identifying_information = idInfo;

        // FIX-AP: Documents for each associated person (IndividualDocuments)
        const uboDocs = await this.buildDocumentsArray(userId, 'ubo', ubo.id as string);
        if (uboDocs.length > 0) person.documents = uboDocs;

        persons.push(person);
      }
    }

    return persons;
  }

  // ───────────────────────────────────────
  //  Value Converters
  // ───────────────────────────────────────

  /**
   * Convierte código ISO alpha-2 a alpha-3.
   * Si ya es alpha-3 (3 chars) o no se encuentra en el mapa, lo retorna tal cual.
   */
  private toAlpha3(code: string): string {
    if (!code) return code;
    const upper = code.toUpperCase().trim();
    if (upper.length === 3) return upper; // Ya es alpha-3
    return BridgeCustomerService.ALPHA2_TO_ALPHA3[upper] ?? upper;
  }

  /** Mapea id_type interno al tipo de documento que Bridge acepta. */
  private mapIdType(idType: string): string {
    const map: Record<string, string> = {
      passport: 'passport',
      drivers_license: 'drivers_license',
      national_id: 'national_id',
    };
    return map[idType] ?? idType;
  }

  // ───────────────────────────────────────
  //  Wallet Initialization
  // ───────────────────────────────────────

  /**
   * Pre-inicializa el balance USD (fiat base) para el usuario.
   *
   * NOTA: La creación de wallets Bridge y balances multi-token ahora se
   * maneja centralizadamente en WalletsService.initializeClientWallets(),
   * que es llamado por el webhook de KYC/KYB aprobado o por el endpoint admin.
   *
   * Este método solo garantiza que exista la fila de balance USD (fiat)
   * que se necesita para operaciones internas antes de que Bridge cree las wallets.
   */
  private async initializeWallet(userId: string) {
    try {
      // Solo asegurar que exista el balance USD (fiat base)
      const { data: existingBalance } = await this.supabase
        .from('balances')
        .select('id')
        .eq('user_id', userId)
        .eq('currency', 'USD')
        .maybeSingle();

      if (!existingBalance) {
        await this.supabase.from('balances').insert({
          user_id: userId,
          currency: 'USD',
          amount: 0,
          available_amount: 0,
          reserved_amount: 0,
        });
        this.logger.log(`Balance USD pre-inicializado para usuario ${userId}`);
      }
    } catch (err) {
      this.logger.warn(
        `Error pre-inicializando balance USD para ${userId}: ${err}`,
      );
    }
  }

  // ───────────────────────────────────────
  //  Logging
  // ───────────────────────────────────────

  private async logActivity(
    userId: string,
    action: string,
    description: string,
  ) {
    await this.supabase.from('activity_logs').insert({
      user_id: userId,
      action,
      description,
    });
  }
}
