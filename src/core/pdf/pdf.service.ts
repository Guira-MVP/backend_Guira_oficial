import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
const pdfmake = require('pdfmake');
import { TDocumentDefinitions } from 'pdfmake/interfaces';
import { formatBoliviaDateTime } from '../../common/utils/date.util';

// ═══════════════════════════════════════════════════════════
//  Guira "Oceanic Trust" PDF Palette
//  Matches the frontend design system identically.
// ═══════════════════════════════════════════════════════════
const COLORS = {
  navy: '#050036',        // brand dark / headings
  primary: '#0055FF',     // brand blue
  accent: '#00D6FF',      // brand cyan/teal
  white: '#FFFFFF',
  surface: '#F4F6FF',     // light background
  muted: '#6B6E9E',       // muted foreground
  mutedOnNavy: '#8A8DC0', // etiquetas discretas sobre la banda navy del header
  border: '#D5D8EE',      // light border
  borderLight: '#ECEFFE', // very subtle divider
  success: '#1DB87A',
  warning: '#F5A623',
  destructive: '#E84040',
  text: '#050036',        // body text
  textSecondary: '#6B6E9E',
};

// ═══════════════════════════════════════════════════════════
//  Etiquetas por flow_type — nomenclatura de registro contable.
//
//  Redactadas para que el comprobante sea legible ante terceros
//  (aduana, banca corresponsal, auditoría, contabilidad externa)
//  sin exigir conocimiento del producto: se describe QUÉ se movió
//  y HACIA DÓNDE, no el nombre comercial del flujo.
//
//  Cuatro familias, en este orden:
//    · Pago Internacional a Proveedor  — salida hacia un tercero
//    · Recepción de Fondos del Exterior — entrada desde el exterior
//    · Constitución de Fondos           — el cliente fondea su cuenta
//    · Retiro de Fondos                 — el cliente retira a un destino propio
//
//  Se renderiza en UN solo punto del PDF: el subtítulo de cabecera,
//  bajo "COMPROBANTE DE TRANSACCIÓN" y precedido por la micro-etiqueta
//  "TIPO DE SERVICIO" (que le da el anclaje semántico ante terceros).
//  Antes se repetía en el panel de monto; se eliminó de ahí porque la
//  repetición pesaba visualmente más que la propia cifra y obligaba a
//  encajar cada etiqueta en dos contenedores distintos.
//  La más larga hoy son 62 caracteres y la cabecera las admite sin
//  desbordar; al añadir entradas mucho más largas, revisar el header.
// ═══════════════════════════════════════════════════════════
const FLOW_LABELS: Record<string, string> = {
  // ── Pago Internacional a Proveedor ──
  bolivia_to_world: 'Pago Internacional a Beneficiario — Transferencia Bancaria',
  bolivia_to_wallet: 'Pago Internacional a Beneficiario — Liquidación en Activos Virtuales',
  wallet_to_wallet: 'Pago Internacional a Beneficiario — Transferencia entre Activos Virtuales',
  wallet_to_world: 'Pago Internacional a Beneficiario — Liquidación desde Wallet Externa',

  // ── Recepción de Fondos del Exterior ──
  world_to_bolivia: 'Recepción de Fondos del Exterior — Abono en Cuenta Nacional',

  // ── Constitución de Fondos ──
  fiat_bo_to_bridge_wallet: 'Constitución de Fondos — Ingreso en Bolivianos',
  crypto_to_bridge_wallet: 'Constitución de Fondos — Ingreso en Activos Virtuales',
  va_deposit: 'Constitución de Fondos — Ingreso vía Cuenta Bancaria Asignada',

  // ── Retiro de Fondos ──
  bridge_wallet_to_fiat_bo: 'Retiro de Fondos — Abono en Cuenta Bancaria Nacional',
  bridge_wallet_to_fiat_us: 'Retiro de Fondos — Abono en Cuenta Bancaria del Exterior',
  bridge_wallet_to_crypto: 'Retiro de Fondos — Envío a Cuenta de Activos Virtuales',
};

const STATUS_LABELS: Record<string, string> = {
  CREATED: 'Creado',
  PENDING: 'Pendiente',
  WAITING_DEPOSIT: 'Esperando Ingreso',
  DEPOSIT_RECEIVED: 'Ingreso Validado',
  PROCESSING: 'En Proceso',
  SENT: 'Enviado',
  COMPLETED: 'Completado',
  CANCELLED: 'Cancelado',
  FAILED: 'Fallido',
  REJECTED: 'Rechazado',
  APPROVED: 'Aprobado',
  SWEPT_EXTERNAL: 'Liquidado Externo',
  REFUNDED: 'Reembolsado',
};

// ═══════════════════════════════════════════════════════════
//  Identificación del emisor para el aviso legal.
//
//  Un comprobante que no nombra a quién lo emite no tiene ante
//  quién reclamar: es lo primero que revisa un oficial de
//  cumplimiento o una banca corresponsal. Rellenar con los datos
//  registrales reales.
//
//  Los campos vacíos se omiten del PDF en vez de imprimirse en
//  blanco, para que un despliegue sin configurar no degrade el
//  documento. Con legalName vacío la cláusula del emisor
//  desaparece por completo.
// ═══════════════════════════════════════════════════════════
const LEGAL_ENTITY = {
  legalName: '',        // TODO: razón social registrada
  taxId: '',            // TODO: NIT
  registration: '',     // TODO: matrícula de comercio u otro registro
  domicile: '',         // TODO: domicilio legal (ciudad, país)
  supportEmail: 'soporte@guiracorp.com',
  website: 'www.guiracorp.com',
};

@Injectable()
export class PdfService {
  private printer: any;
  private readonly logger = new Logger(PdfService.name);

  constructor() {
    const fonts = {
      Helvetica: {
        normal: 'Helvetica',
        bold: 'Helvetica-Bold',
        italics: 'Helvetica-Oblique',
        bolditalics: 'Helvetica-BoldOblique',
      },
    };
    this.printer = pdfmake;
    this.printer.setFonts(fonts);
  }

  // ─── Helpers ──────────────────────────────────────────

  private toDisplay(val: any): string {
    return val === null || val === undefined || val === '' ? 'N/D' : String(val);
  }

  private truncateAddress(val: any): string {
    const s = this.toDisplay(val);
    if (s === 'N/D' || s.length <= 13) return s;
    return `${s.slice(0, 5)}..................${s.slice(-5)}`;
  }

  private filterNd(rows: any[][]): any[][] {
    return rows.filter(r => r[1]?.text !== 'N/D');
  }

  private buildExplorerUrl(
    value: string | undefined | null,
    network: string | undefined | null,
    type: 'tx' | 'address',
  ): string | null {
    if (!value || value === 'N/D' || !network) return null;
    const n = network.toLowerCase();
    switch (n) {
      case 'solana':
        return type === 'tx'
          ? `https://solscan.io/tx/${value}`
          : `https://solscan.io/account/${value}`;
      case 'tron':
        return type === 'tx'
          ? `https://tronscan.org/#/transaction/${value}`
          : `https://tronscan.org/#/address/${value}`;
      case 'ethereum':
        return type === 'tx'
          ? `https://etherscan.io/tx/${value}`
          : `https://etherscan.io/address/${value}`;
      case 'polygon':
        return type === 'tx'
          ? `https://polygonscan.com/tx/${value}`
          : `https://polygonscan.com/address/${value}`;
      case 'stellar':
        return type === 'tx'
          ? `https://stellar.expert/explorer/public/tx/${value}`
          : `https://stellar.expert/explorer/public/account/${value}`;
      default:
        return null;
    }
  }

  private readMeta(meta: any, key: string): string {
    if (!meta || typeof meta !== 'object') return '';
    const val = meta[key];
    return typeof val === 'string' || typeof val === 'number' ? String(val) : '';
  }

  private fmtDate(val: string): string {
    // Hora de Bolivia (UTC-4). El valor se guarda en UTC; aquí solo se presenta.
    return formatBoliviaDateTime(val, {
      hour12: true,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private fmtAmount(val: any): string {
    const n = Number(val);
    if (Number.isNaN(n)) return String(val ?? '0.00');
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  private statusColor(status: string): string {
    const s = status.toUpperCase();
    if (s === 'COMPLETED' || s === 'APPROVED') return COLORS.success;
    if (s === 'FAILED' || s === 'REJECTED' || s === 'CANCELLED') return COLORS.destructive;
    if (s === 'PENDING' || s === 'WAITING_DEPOSIT') return COLORS.warning;
    if (s === 'PROCESSING' || s === 'SENT') return COLORS.primary;
    return COLORS.muted;
  }

  private loadLogo(): any {
    try {
      const logoPath = path.join(process.cwd(), 'assets', 'LOGO_GUIRRA_HORIZONTAL.png');
      if (fs.existsSync(logoPath)) {
        const b64 = fs.readFileSync(logoPath).toString('base64');
        return { image: `data:image/png;base64,${b64}`, width: 120, alignment: 'left' as const };
      }
    } catch (err) {
      this.logger.warn('No se pudo cargar el logo para el PDF', err);
    }
    return { text: 'GUIRA', style: 'brandFallback' };
  }

  /** Builds a label → value row for the detail table */
  private row(label: string, value: string, opts?: { color?: string }): any[] {
    return [
      { text: label, style: 'tLabel' },
      { text: value, style: 'tValue', color: opts?.color ?? COLORS.text },
    ];
  }

  /** Like row(), but renders the value as a clickable link when url is provided */
  private linkRow(label: string, displayValue: string, url: string | null, opts?: { color?: string }): any[] {
    if (url) {
      return [
        { text: label, style: 'tLabel' },
        { text: displayValue, style: 'tValue', color: COLORS.text, link: url, decoration: 'underline' },
      ];
    }
    return this.row(label, displayValue, opts);
  }

  /** Formats a bank_details.address object into a single display line */
  private formatSupplierAddress(addr: any): string {
    if (!addr || typeof addr !== 'object') return 'N/D';
    const parts: string[] = [];
    if (addr.street_line_1) parts.push(addr.street_line_1);
    if (addr.street_line_2) parts.push(addr.street_line_2);
    const cityState = [addr.city, addr.state].filter(Boolean).join(', ');
    if (cityState) parts.push(cityState);
    if (addr.postal_code) parts.push(addr.postal_code);
    if (addr.country) parts.push(addr.country);
    return parts.length ? parts.join(', ') : 'N/D';
  }

  /** Convierte código ISO alpha-3 (o alpha-2) a nombre de país en español. */
  private resolveCountryName(code: string | null | undefined): string {
    if (!code) return 'N/D';
    const NAMES: Record<string, string> = {
      BOL: 'Bolivia', USA: 'Estados Unidos', MEX: 'México', ARG: 'Argentina',
      BRA: 'Brasil', COL: 'Colombia', PER: 'Perú', CHL: 'Chile', ECU: 'Ecuador',
      URY: 'Uruguay', PRY: 'Paraguay', VEN: 'Venezuela', PAN: 'Panamá',
      GTM: 'Guatemala', HND: 'Honduras', SLV: 'El Salvador', NIC: 'Nicaragua',
      CRI: 'Costa Rica', DOM: 'República Dominicana', CUB: 'Cuba', PRI: 'Puerto Rico',
      ESP: 'España', DEU: 'Alemania', FRA: 'Francia', GBR: 'Reino Unido',
      ITA: 'Italia', PRT: 'Portugal', NLD: 'Países Bajos', CHE: 'Suiza',
      BEL: 'Bélgica', AUT: 'Austria', SWE: 'Suecia', NOR: 'Noruega',
      CAN: 'Canadá', AUS: 'Australia', JPN: 'Japón', CHN: 'China',
      IND: 'India', ZAF: 'Sudáfrica', ISR: 'Israel', ARE: 'Emiratos Árabes',
      // alpha-2 fallbacks
      BO: 'Bolivia', US: 'Estados Unidos', MX: 'México', AR: 'Argentina',
      BR: 'Brasil', CO: 'Colombia', PE: 'Perú', CL: 'Chile', EC: 'Ecuador',
      ES: 'España', DE: 'Alemania', FR: 'Francia', GB: 'Reino Unido',
    };
    return NAMES[code.toUpperCase()] ?? code.toUpperCase();
  }

  /** Etiquetas legibles para cada payment_rail. */
  private readonly RAIL_LABELS: Record<string, string> = {
    ach: 'ACH – EE.UU.',
    wire: 'Wire Transfer',
    sepa: 'SEPA – Europa',
    spei: 'SPEI – México',
    pix: 'PIX – Brasil',
    bre_b: 'Bre-B – Colombia',
    faster_payments: 'Faster Payments – Reino Unido',
    co_bank_transfer: 'Transferencia Bancaria – Colombia',
    crypto: 'Transferencia Crypto',
  };

  /** Etiquetas legibles para tipo de cuenta bancaria. */
  private readonly ACCOUNT_TYPE_LABELS: Record<string, string> = {
    checking: 'Cuenta Corriente',
    savings: 'Caja de Ahorro',
    electronic_deposit: 'Depósito Electrónico',
  };

  /** Horizontal divider line */
  private divider(width = 515): any {
    return {
      canvas: [{ type: 'line', x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 0.75, lineColor: COLORS.border }],
      margin: [0, 0, 0, 0],
    };
  }

  // ─── Origin details (per service) ─────────────────────

  // fiat_bo_to_bridge_wallet: source_currency stores the stablecoin, not the BOB origin.
  // Nota: amount_origin / fee_total / origin_currency NO existen como columnas en
  // payment_orders. Las columnas reales son amount, fee_amount y source_currency/currency.
  // Se usa en dos sitios (panel de monto y tabla de detalle), de ahí el helper.
  private resolveOriginCurrency(order: any): string {
    return order.flow_type === 'fiat_bo_to_bridge_wallet'
      ? (order.currency ?? '').toUpperCase()
      : (order.source_currency ?? order.currency ?? '').toUpperCase();
  }

  private buildOriginRows(order: any, clientWallet: any): any[][] {
    const ft = order.flow_type;
    const originCcy = this.resolveOriginCurrency(order);

    // Tipo de cambio: los flujos 1:1 (stablecoin) muestran una etiqueta explícita.
    // Estos flujos guardan exchange_rate_applied = 1.0, por lo que el chequeo de
    // stablecoin DEBE tener prioridad; de lo contrario la etiqueta nunca se mostraba
    // (el valor 1.0 hacía que siempre se imprimiera el "1" crudo).
    // bridge_wallet_to_fiat_us y wallet_to_world excluidos: aceptan divisas no-USD
    // (EUR, MXN, BRL, COP, GBP) con tipo de cambio real distinto de 1, por lo que
    // deben leer exchange_rate_applied (el webhook lo sobreescribe con la tasa
    // real de Bridge al completarse).
    const STABLECOIN_FLOWS = [
      'wallet_to_wallet',
      'bridge_wallet_to_crypto',
      'crypto_to_bridge_wallet',
    ];
    const exchangeRateRaw = STABLECOIN_FLOWS.includes(ft)
      ? '1.00 (stablecoin)'
      : this.toDisplay(order.exchange_rate_applied);

    // Añadir par de divisas al tipo de cambio para flujos con conversión real.
    // La tasa siempre representa "unidades de originCcy por 1 unidad de la divisa no-BOB".
    const destCcyForRate = (order.destination_currency ?? '').toUpperCase();
    const isBobOrigin = ['BOB', 'BS'].includes(originCcy.toUpperCase());
    const foreignCcy = isBobOrigin ? destCcyForRate : originCcy;
    const baseCcy = isBobOrigin ? originCcy : destCcyForRate;
    const showPair = !STABLECOIN_FLOWS.includes(ft)
      && exchangeRateRaw !== 'N/D'
      && foreignCcy
      && baseCcy
      && foreignCcy !== baseCcy;
    const exchangeRateDisplay = showPair
      ? `${exchangeRateRaw}  (1 ${foreignCcy} = ${exchangeRateRaw} ${baseCcy})`
      : exchangeRateRaw;

    const rows: any[][] = [
      this.row('Monto Origen', `${this.fmtAmount(order.amount)} ${originCcy}`),
      this.row('Tarifa', `${this.fmtAmount(order.fee_amount)} ${originCcy}`),
      this.row('Tipo de Cambio', exchangeRateDisplay),
    ];

    // ── Off-ramp flows: show source Bridge wallet ──────────
    if (['bridge_wallet_to_fiat_bo', 'bridge_wallet_to_fiat_us', 'bridge_wallet_to_crypto'].includes(ft)) {
      rows.push(
        this.linkRow('Cuenta Origen', this.truncateAddress(clientWallet?.address), this.buildExplorerUrl(clientWallet?.address, clientWallet?.network, 'address')),
        this.row('Red Origen', this.toDisplay(clientWallet?.network)),
      );
    }

    // ── Depósitos on-chain desde wallet externa: red + dirección del remitente ──
    // wallet_to_world comparte la mecánica de crypto_to_bridge_wallet: el cliente
    // paga desde su propia wallet (Binance, etc.), NO desde la billetera Guira, así
    // que aquí no se muestra clientWallet sino el remitente real que registró Bridge.
    if (ft === 'crypto_to_bridge_wallet' || ft === 'wallet_to_world') {
      rows.push(
        this.row('Red de Ingreso', this.toDisplay(order.source_network)),
      );
      // source_address = the external crypto wallet that sent funds to Bridge
      if (order.source_address) {
        rows.push(this.linkRow('Dirección de Ingreso', this.truncateAddress(order.source_address), this.buildExplorerUrl(order.source_address, order.source_network, 'address')));
      }
    }

    // ── fiat_bo_to_bridge_wallet: Bridge PSAV intermediate address ──
    if (ft === 'fiat_bo_to_bridge_wallet') {
      // source_address = Bridge/PSAV intermediate wallet that converted BOB and sent stablecoin.
      // Hasta que el transfer se completa, source_address es null; usamos como fallback la
      // liquidation address (to_address) capturada en las instrucciones de depósito al crear.
      const psavAddress = order.source_address
        || this.readMeta(order.bridge_source_deposit_instructions, 'to_address');
      if (psavAddress) {
        rows.push(this.linkRow('Direccion PSAV Guira', this.truncateAddress(psavAddress), this.buildExplorerUrl(psavAddress, order.source_network, 'address')));
      }
      if (order.source_network) {
        rows.push(this.row('Red de Salida Guira', this.toDisplay(order.source_network)));
      }
      // exchange_fee = Bridge's own conversion fee (show only when non-zero)
      const bridgeFee = Number(order.exchange_fee);
      if (order.exchange_fee != null && !Number.isNaN(bridgeFee) && bridgeFee !== 0) {
        rows.push(this.row('Tarifa aplicable', `${this.fmtAmount(bridgeFee)} ${order.source_currency ?? ''}`));
      }
    }

    // ── wallet_to_wallet: actual sending address from DB ──
    if (ft === 'wallet_to_wallet') {
      // source_address from DB is the actual sending external wallet (more accurate than clientWallet)
      const srcAddr = order.source_address ?? clientWallet?.address;
      const srcNet = order.source_network ?? clientWallet?.network;
      rows.push(
        this.row('Red Origen', this.toDisplay(srcNet)),
        this.linkRow('Cuenta Origen', this.truncateAddress(srcAddr), this.buildExplorerUrl(srcAddr, srcNet, 'address')),
      );
    }

    return rows;
  }

  // ─── Beneficiary summary (right column of party grid) ─

  private buildBeneficiarySummaryRows(order: any, supplier: any, clientBankAccount?: any): any[][] {
    const rows: any[][] = [];
    const ft = order.flow_type;
    const bd: any = supplier?.bank_details ?? {};

    if (ft === 'bolivia_to_world') {
      if (supplier?.name) rows.push(this.row('Proveedor', this.toDisplay(supplier.name)));
      if (order.destination_account_holder) rows.push(this.row('Titular', this.toDisplay(order.destination_account_holder)));
      if (supplier?.contact_email) rows.push(this.row('Email de Contacto', this.toDisplay(supplier.contact_email)));
      const rail = (supplier?.payment_rail ?? '').toLowerCase();
      const country = rail === 'sepa' ? bd.iban_country : bd.address?.country;
      if (country) rows.push(this.row('País', this.resolveCountryName(country)));
    } else if (ft === 'world_to_bolivia') {
      const holder = clientBankAccount?.account_holder || order.destination_account_holder;
      if (holder) rows.push(this.row('Titular', this.toDisplay(holder)));
      rows.push(this.row('País', 'Bolivia'));
    } else if (['bolivia_to_wallet', 'wallet_to_wallet'].includes(ft)) {
      if (supplier?.name) rows.push(this.row('Proveedor', this.toDisplay(supplier.name)));
      if (supplier?.contact_email) rows.push(this.row('Email de Contacto', this.toDisplay(supplier.contact_email)));
    } else if (['fiat_bo_to_bridge_wallet', 'crypto_to_bridge_wallet'].includes(ft)) {
      rows.push(this.row('Titular', 'Cuenta Propia'));
    } else if (ft === 'bridge_wallet_to_fiat_bo') {
      const holder = clientBankAccount?.account_holder || order.destination_account_holder;
      if (holder) rows.push(this.row('Titular', this.toDisplay(holder)));
      rows.push(this.row('País', 'Bolivia'));
    } else if (ft === 'bridge_wallet_to_fiat_us' || ft === 'wallet_to_world') {
      // Mismo destino en ambos flujos: la cuenta bancaria del proveedor.
      // Solo cambia el origen de los fondos (billetera Guira vs. wallet externa).
      if (supplier?.name) rows.push(this.row('Proveedor', this.toDisplay(supplier.name)));
      const holder = order.destination_account_holder
        || bd.business_name
        || [bd.first_name, bd.last_name].filter(Boolean).join(' ')
        || supplier?.name;
      if (holder) rows.push(this.row('Titular', this.toDisplay(holder)));
      if (supplier?.contact_email) rows.push(this.row('Email de Contacto', this.toDisplay(supplier.contact_email)));
      const rail = (supplier?.payment_rail ?? '').toLowerCase();
      const country = rail === 'sepa' ? bd.iban_country : bd.address?.country;
      if (country) rows.push(this.row('País', this.resolveCountryName(country)));
    } else if (ft === 'bridge_wallet_to_crypto') {
      if (supplier?.name) rows.push(this.row('Proveedor', this.toDisplay(supplier.name)));
      if (supplier?.contact_email) rows.push(this.row('Email de Contacto', this.toDisplay(supplier.contact_email)));
    }

    return rows;
  }

  // ─── Banking details (section 2 — no identity fields) ──

  private buildBankingRows(order: any, supplier: any, clientWallet: any, clientBankAccount?: any): any[][] {
    const rows: any[][] = [];
    const ft = order.flow_type;

    // ── bolivia_to_world ─────────────────────────────────
    if (ft === 'bolivia_to_world') {
      const bd: any = supplier?.bank_details ?? {};
      const rail = (supplier?.payment_rail ?? '').toLowerCase();
      const railLabel = this.RAIL_LABELS[rail] ?? (rail ? rail.toUpperCase() : 'N/D');

      rows.push(
        this.row('Método de Envío', railLabel),
        this.row('Banco Destino', this.toDisplay(order.destination_bank_name)),
      );

      if (rail === 'sepa') {
        const iban = bd.iban || order.destination_account_number;
        if (iban) rows.push(this.row('IBAN', this.toDisplay(iban)));
        if (bd.swift_bic) rows.push(this.row('SWIFT / BIC', this.toDisplay(bd.swift_bic)));
        if (bd.iban_country) rows.push(this.row('País (IBAN)', this.resolveCountryName(bd.iban_country)));
      } else if (rail === 'spei') {
        rows.push(this.row('CLABE', this.toDisplay(bd.clabe || order.destination_account_number)));
      } else if (rail === 'pix') {
        rows.push(this.row('Clave PIX', this.toDisplay(bd.pix_key || order.destination_account_number)));
        if (bd.document_number) rows.push(this.row('CPF / CNPJ', this.toDisplay(bd.document_number)));
      } else if (rail === 'bre_b') {
        rows.push(this.row('Clave Bre-B', this.toDisplay(bd.bre_b_key || order.destination_account_number)));
      } else if (rail === 'faster_payments') {
        rows.push(this.row('Cuenta Destino', this.toDisplay(order.destination_account_number)));
        if (bd.sort_code) rows.push(this.row('Sort Code', this.toDisplay(bd.sort_code)));
      } else if (rail === 'co_bank_transfer') {
        rows.push(this.row('Cuenta Destino', this.toDisplay(order.destination_account_number)));
        if (bd.bank_code) rows.push(this.row('Código Banco', this.toDisplay(bd.bank_code)));
        const docStr = [bd.document_type?.toUpperCase(), bd.document_number].filter(Boolean).join(' ');
        if (docStr) rows.push(this.row('Documento Beneficiario', docStr));
        if (bd.phone_number) rows.push(this.row('Teléfono Beneficiario', this.toDisplay(bd.phone_number)));
      } else {
        rows.push(this.row('Cuenta Destino', this.toDisplay(order.destination_account_number)));
        if (bd.routing_number) rows.push(this.row('Routing Number', this.toDisplay(bd.routing_number)));
        if (bd.swift_bic) rows.push(this.row('SWIFT / BIC', this.toDisplay(bd.swift_bic)));
        const acctTypeLabel = this.ACCOUNT_TYPE_LABELS[bd.checking_or_savings ?? ''];
        if (acctTypeLabel) rows.push(this.row('Tipo de Cuenta', acctTypeLabel));
      }

      rows.push(this.row('Moneda Destino', this.toDisplay(order.destination_currency)));
      if (!['sepa'].includes(rail)) {
        const addrCountry = bd.address?.country;
        if (addrCountry) rows.push(this.row('País Destino', this.resolveCountryName(addrCountry)));
      }
      const addr = supplier?.bank_details?.address;
      if (addr) rows.push(this.row('Dirección del Beneficiario', this.formatSupplierAddress(addr)));
    }

    // ── world_to_bolivia ─────────────────────────────────
    else if (ft === 'world_to_bolivia') {
      const cba = clientBankAccount;
      const bankName = cba?.bank_name || order.destination_bank_name || '';
      const acctNumber = cba?.account_number || order.destination_account_number || '';
      const acctType = this.ACCOUNT_TYPE_LABELS[cba?.account_type ?? ''] ?? null;
      rows.push(
        this.row('Método de Recepción', 'Transferencia Bancaria Local'),
        this.row('Banco Destino', this.toDisplay(bankName)),
        this.row('Cuenta Destino', this.toDisplay(acctNumber)),
      );
      if (acctType) rows.push(this.row('Tipo de Cuenta', acctType));
      rows.push(
        this.row('Moneda Destino', this.toDisplay(order.destination_currency ?? 'BOB')),
        this.row('País Destino', 'Bolivia'),
      );
    }

    // ── bolivia_to_wallet / wallet_to_wallet ─────────────
    else if (['bolivia_to_wallet', 'wallet_to_wallet'].includes(ft)) {
      const walletAddr = supplier?.bank_details?.wallet_address ?? order.destination_address;
      const walletNet = supplier?.bank_details?.wallet_network ?? order.destination_network;
      rows.push(
        this.row('Método de Envío', this.RAIL_LABELS['crypto']),
        this.linkRow('Wallet Destino', this.toDisplay(walletAddr), this.buildExplorerUrl(walletAddr, walletNet, 'address')),
        this.row('Red Destino', this.toDisplay(walletNet)),
        this.row('Moneda Destino', this.toDisplay(supplier?.bank_details?.wallet_currency ?? order.destination_currency)),
      );
    }

    // ── On-ramps: fiat/crypto → bridge_wallet ─────────────
    else if (['fiat_bo_to_bridge_wallet', 'crypto_to_bridge_wallet'].includes(ft)) {
      rows.push(
        this.linkRow('Cuenta Destino', this.toDisplay(clientWallet?.address), this.buildExplorerUrl(clientWallet?.address, clientWallet?.network, 'address')),
        this.row('Red Destino', this.toDisplay(clientWallet?.network)),
        this.row('Moneda Destino', this.toDisplay(order.destination_currency ?? order.currency)),
      );
    }

    // ── va_deposit ────────────────────────────────────────
    else if (ft === 'va_deposit') {
      const destCcy = (order.destination_currency ?? order.currency ?? 'USDC').toUpperCase();
      rows.push(
        this.row('Canal de Depósito', 'Cuenta Virtual (ACH / Wire)'),
        this.row('Moneda Recibida', destCcy),
      );
      if (order.sender_name) rows.push(this.row('Remitente', this.toDisplay(order.sender_name)));
      if (order.va_deposit_status) rows.push(this.row('Estado del Ingreso', this.toDisplay(order.va_deposit_status)));
    }

    // ── bridge_wallet_to_fiat_bo ─────────────────────────
    else if (ft === 'bridge_wallet_to_fiat_bo') {
      const cba = clientBankAccount;
      const bankName = cba?.bank_name || order.destination_bank_name || '';
      const acctNumber = cba?.account_number || order.destination_account_number || order.destination_address || '';
      const acctType = this.ACCOUNT_TYPE_LABELS[cba?.account_type ?? ''] ?? null;
      rows.push(
        this.row('Método de Retiro', 'Transferencia Bancaria Local'),
        this.row('Banco Destino', this.toDisplay(bankName)),
        this.row('Cuenta Destino', this.toDisplay(acctNumber)),
      );
      if (acctType) rows.push(this.row('Tipo de Cuenta', acctType));
      rows.push(
        this.row('Moneda Destino', this.toDisplay(order.destination_currency ?? 'BOB')),
        this.row('País Destino', 'Bolivia'),
      );
    }

    // ── bridge_wallet_to_fiat_us / wallet_to_world ───────
    // Bloque de destino compartido: ambos liquidan en la cuenta bancaria del
    // proveedor por el mismo riel (ACH, Wire, SEPA, SPEI, PIX, Bre-B, FPS).
    else if (ft === 'bridge_wallet_to_fiat_us' || ft === 'wallet_to_world') {
      const bd: any = supplier?.bank_details ?? {};
      const rail = (supplier?.payment_rail ?? '').toLowerCase();
      const railLabel = this.RAIL_LABELS[rail] ?? (rail ? rail.toUpperCase() : 'N/D');
      const bankName = bd.bank_name || order.destination_bank_name || '';

      if (rail) rows.push(this.row('Método de Envío', railLabel));
      rows.push(this.row('Banco Destino', this.toDisplay(bankName)));

      if (rail === 'sepa') {
        const iban = bd.iban || bd.account_number || order.destination_account_number || '';
        if (iban) rows.push(this.row('IBAN', this.toDisplay(iban)));
        if (bd.swift_bic) rows.push(this.row('SWIFT / BIC', this.toDisplay(bd.swift_bic)));
        if (bd.iban_country) rows.push(this.row('País (IBAN)', this.resolveCountryName(bd.iban_country)));
      } else if (rail === 'spei') {
        rows.push(this.row('CLABE', this.toDisplay(bd.clabe || bd.account_number || order.destination_account_number)));
      } else if (rail === 'pix') {
        rows.push(this.row('Clave PIX', this.toDisplay(bd.pix_key || bd.account_number || order.destination_account_number)));
        if (bd.document_number) rows.push(this.row('CPF / CNPJ', this.toDisplay(bd.document_number)));
      } else if (rail === 'faster_payments') {
        rows.push(this.row('Cuenta Destino', this.toDisplay(bd.account_number || order.destination_account_number)));
        if (bd.sort_code) rows.push(this.row('Sort Code', this.toDisplay(bd.sort_code)));
      } else {
        rows.push(this.row('Cuenta Destino', this.toDisplay(bd.account_number || order.destination_account_number || order.destination_address)));
        if (bd.routing_number) rows.push(this.row('Routing Number', this.toDisplay(bd.routing_number)));
        if (bd.swift_bic) rows.push(this.row('SWIFT / BIC', this.toDisplay(bd.swift_bic)));
        const acctTypeLabel = this.ACCOUNT_TYPE_LABELS[bd.checking_or_savings ?? ''];
        if (acctTypeLabel) rows.push(this.row('Tipo de Cuenta', acctTypeLabel));
      }

      rows.push(this.row('Moneda Destino', this.toDisplay(order.destination_currency ?? 'USD')));
      const addrUs = bd.address;
      if (addrUs) rows.push(this.row('Dirección del Beneficiario', this.formatSupplierAddress(addrUs)));
    }

    // ── bridge_wallet_to_crypto ──────────────────────────
    else if (ft === 'bridge_wallet_to_crypto') {
      const destAddr = supplier?.bank_details?.wallet_address ?? order.destination_address;
      const destNet = supplier?.bank_details?.wallet_network ?? order.destination_network;
      const destCcy = supplier?.bank_details?.wallet_currency ?? order.destination_currency;
      rows.push(
        this.row('Método de Envío', this.RAIL_LABELS['crypto']),
        this.linkRow('Wallet Destino', this.toDisplay(destAddr), this.buildExplorerUrl(destAddr, destNet, 'address')),
        this.row('Red Destino', this.toDisplay(destNet)),
        this.row('Moneda Destino', this.toDisplay(destCcy)),
      );
    }

    // ── Generic fallback ─────────────────────────────────
    else {
      rows.push(this.row('Dirección Destino', this.toDisplay(order.destination_address)));
      if (order.destination_currency) {
        rows.push(this.row('Moneda Destino', order.destination_currency.toUpperCase()));
      }
    }

    return rows;
  }

  // ─── Stablecoin resolution ────────────────────────────

  private resolveStablecoin(order: any): string {
    // On-ramps: stablecoin is the destination
    if ([
      'crypto_to_bridge_wallet', 'bridge_wallet_to_crypto',
      'wallet_to_wallet', 'bolivia_to_wallet',
      'fiat_bo_to_bridge_wallet',
      // va_deposit: el stablecoin acreditado es la moneda destino (p.ej. USDC)
      'va_deposit',
    ].includes(order.flow_type)) {
      return order.destination_currency ?? order.currency ?? 'N/D';
    }
    // Off-ramps to fiat: stablecoin is the source (stored in currency column)
    if (['bridge_wallet_to_fiat_bo', 'bridge_wallet_to_fiat_us', 'wallet_to_world'].includes(order.flow_type)) {
      return (order.currency ?? order.source_currency ?? 'N/D').toUpperCase();
    }
    return 'N/D';
  }

  // ─── Aviso legal ──────────────────────────────────────

  /**
   * Cláusulas del aviso legal, numeradas.
   *
   * Numeradas y separadas a propósito: permite que un tercero cite
   * "cláusula 4" en una consulta o un expediente, cosa que un párrafo
   * corrido no permite. Cada cláusula cubre una pregunta concreta que
   * suele aparecer al presentar el comprobante ante un banco, aduana o
   * auditoría.
   */
  private buildLegalClauses(): string[] {
    const clauses: string[] = [];

    // 1. Emisor — se omite si no hay razón social configurada.
    if (LEGAL_ENTITY.legalName) {
      const ids = [
        LEGAL_ENTITY.taxId ? `NIT ${LEGAL_ENTITY.taxId}` : null,
        LEGAL_ENTITY.registration ? `Matrícula ${LEGAL_ENTITY.registration}` : null,
        LEGAL_ENTITY.domicile || null,
      ].filter(Boolean).join(', ');
      clauses.push(
        `Emisor. Este comprobante es emitido por ${LEGAL_ENTITY.legalName}` +
        (ids ? ` (${ids})` : '') +
        ', responsable del procesamiento de la operación aquí detallada.',
      );
    }

    clauses.push(
      // 2. Qué ES el documento. El aviso anterior solo decía lo que no era.
      'Naturaleza. Constituye constancia de la ejecución de una orden de pago instruida por el ordenante. ' +
      'Se genera automáticamente a partir de los registros del sistema y refleja el estado de la operación a la fecha de emisión.',

      // 3. Validez sin firma manuscrita: la objeción más habitual ante un PDF.
      'Validez. Documento generado por medios electrónicos. Es válido y oponible sin firma manuscrita ni sello, ' +
      'conforme a la normativa vigente sobre documentos electrónicos.',

      // 4. Alcance fiscal.
      'Alcance fiscal. No constituye factura, nota fiscal ni comprobante tributario, y no sustituye la documentación ' +
      'fiscal o contable que corresponda emitir a las partes.',

      // 5. Delimitación del servicio: evita que se lea como actividad financiera regulada.
      'Servicio. La operación corresponde a un servicio de procesamiento y transferencia de fondos por cuenta y orden del cliente. ' +
      'No implica captación de recursos del público, intermediación financiera, asesoramiento en inversiones ni garantía de rendimiento.',

      // 6. Explica por qué las dos cifras del panel no coinciden, antes de que lo pregunten.
      'Montos. El tipo de cambio y las tarifas consignados son los aplicados al momento de la ejecución. La diferencia entre ' +
      'el monto ordenado y el monto acreditado corresponde a dichos conceptos. Fechas y horas se expresan en hora oficial de Bolivia (UTC-4).',

      // 7. Lo que una banca corresponsal busca explícitamente.
      'Cumplimiento. La operación fue sometida a los procedimientos de debida diligencia del cliente y de prevención de legitimación ' +
      'de ganancias ilícitas y financiamiento del terrorismo aplicables al emisor.',

      // 8. Confidencialidad + cómo validar que el PDF es auténtico.
      'Confidencialidad y verificación. Contiene datos personales y financieros; su uso queda restringido al titular y a las entidades ' +
      `legalmente facultadas para requerirlo. La autenticidad puede verificarse citando el N° de operación ante ${LEGAL_ENTITY.supportEmail}.`,
    );

    return clauses;
  }

  private buildLegalNotice(): any {
    const clauses = this.buildLegalClauses();
    return {
      table: {
        widths: ['*'],
        body: [[
          {
            stack: [
              { text: 'AVISO LEGAL', style: 'legalHeading' },
              ...clauses.map((c, i) => ({
                text: `${i + 1}. ${c}`,
                style: 'disclaimer',
                alignment: 'justify' as const,
                margin: [0, i === 0 ? 0 : 3, 0, 0] as [number, number, number, number],
              })),
            ],
            fillColor: COLORS.surface,
            margin: [12, 10, 12, 10],
          },
        ]],
      },
      layout: {
        hLineWidth: () => 0.5,
        vLineWidth: () => 0.5,
        hLineColor: () => COLORS.border,
        vLineColor: () => COLORS.border,
      },
      // El aviso pierde autoridad partido a la mitad entre dos páginas.
      unbreakable: true,
    };
  }

  // ─── Table layout helper ──────────────────────────────

  private cleanTableLayout(): any {
    return {
      hLineWidth: (i: number, node: any) => (i === 0 || i === node.table.body.length ? 0 : 0.5),
      vLineWidth: () => 0,
      hLineColor: () => COLORS.borderLight,
      paddingLeft: () => 8,
      paddingRight: () => 8,
      paddingTop: () => 7,
      paddingBottom: () => 7,
    };
  }

  // ─── Merge two 2-col row arrays into 4-col rows ───────

  private mergeColumns(left: any[][], right: any[][]): any[][] {
    const maxLen = Math.max(left.length, right.length);
    const merged: any[][] = [];
    const empty = { text: '', style: 'tLabel' };
    for (let i = 0; i < maxLen; i++) {
      const l = left[i] ?? [empty, empty];
      const r = right[i] ?? [empty, empty];
      merged.push([l[0], l[1], r[0], r[1]]);
    }
    return merged;
  }

  // ═══════════════════════════════════════════════════════
  //  MAIN PDF GENERATION
  // ═══════════════════════════════════════════════════════

  async generatePaymentPdf(
    order: any,
    supplier: any | null,
    client?: any,
    clientWallet?: any,
    clientBankAccount?: any,
  ): Promise<Buffer> {
    try {
      const ft = order.flow_type ?? 'N/D';
      // amount_destination es la columna real; fallback a net_amount para flujos 1:1
      // que aún no han confirmado el monto final.
      const amountDest = order.amount_destination ?? order.net_amount ?? 0;
      const isFlexiblePending =
        order.flow_type === 'wallet_to_wallet' &&
        amountDest === 0 &&
        order.status !== 'completed';
      const amountDestText = isFlexiblePending
        ? 'Por definir'
        : `${this.fmtAmount(amountDest)} ${(order.destination_currency ?? order.currency ?? '').toUpperCase()}`;
      // Monto ordenado: lo que el ordenante instruyó mover, contrapartida del
      // monto acreditado. Ambas cifras NO cuadran entre sí a propósito — la
      // diferencia es la comisión más el tipo de cambio, desglosados en la tabla
      // de detalle. De ahí "ordenado" y no "debitado": el vocabulario contable
      // haría esperar un asiento balanceado que aquí no aplica.
      // Sube al panel de monto para que la caja resuma la operación económica
      // completa sin obligar a bajar a la tabla de detalle.
      const originCcy = this.resolveOriginCurrency(order);
      const amountOriginText = order.amount == null
        ? 'N/D'
        : `${this.fmtAmount(order.amount)} ${originCcy}`.trim();
      const statusUpper = this.toDisplay(order.status).toUpperCase();
      const statusLabel = STATUS_LABELS[statusUpper] ?? statusUpper;
      const flowLabel = FLOW_LABELS[ft] ?? ft.toUpperCase();
      const stColor = this.statusColor(statusUpper);
      const logo = this.loadLogo();

      const completedRender = order.completed_at
        ? this.fmtDate(order.completed_at)
        : 'Pendiente';

      const stablecoin = this.resolveStablecoin(order);
      const beneficiarySummaryRows = this.filterNd(this.buildBeneficiarySummaryRows(order, supplier, clientBankAccount));
      const bankingRows = this.filterNd(this.buildBankingRows(order, supplier, clientWallet, clientBankAccount));
      const purposeRow: any[][] = order.business_purpose
        ? [this.row('Propósito', this.toDisplay(order.business_purpose))]
        : [];
      const operationRows = this.filterNd([...purposeRow, ...this.buildOriginRows(order, clientWallet)]);

      // ── Traceability rows ──────────────────────────────
      const traceRows: any[][] = [
        this.row('Stablecoin', this.toDisplay(stablecoin)),
        this.row('Completado', completedRender),
      ];

      // Bridge Transfer ID — all Bridge flows
      if (order.bridge_transfer_id) {
        traceRows.push(this.row('ID Transferencia Guira', this.toDisplay(order.bridge_transfer_id)));
      }

      // Bridge Deposit ID — va_deposit
      if (order.deposit_id) {
        traceRows.push(this.row('ID de Ingreso', this.toDisplay(order.deposit_id)));
      }

      // Fedwire IMAD — the reference the correspondent bank uses in traces and disputes
      if (order.imad) {
        traceRows.push(this.row('IMAD (Fedwire)', this.toDisplay(order.imad)));
      }

      // ACH trace number — inbound deposits and outbound ACH payouts
      if (order.ach_trace_number) {
        traceRows.push(this.row('N° de Traza ACH', this.toDisplay(order.ach_trace_number)));
      }

      // Destination blockchain tx hash — proof of delivery
      if (order.tx_hash) {
        // Manual flows use tx_hash as a staff-entered reference, not a real blockchain hash
        const isManualRef = ['bridge_wallet_to_fiat_bo', 'bolivia_to_world', 'bolivia_to_wallet'].includes(ft);
        const txLabel = isManualRef ? 'Ref. de Ejecución' : 'Hash Blockchain Destino';
        const txUrl = isManualRef
          ? null
          : this.buildExplorerUrl(order.tx_hash, order.destination_network ?? order.source_network, 'tx');
        traceRows.push(this.linkRow(txLabel, this.truncateAddress(order.tx_hash), txUrl));
      }

      // Source blockchain tx hash — proof that client sent funds
      if (order.source_tx_hash) {
        traceRows.push(this.linkRow(
          'Hash Blockchain Origen',
          this.truncateAddress(order.source_tx_hash),
          this.buildExplorerUrl(order.source_tx_hash, order.source_network, 'tx'),
        ));
      }

      // Staff approval date — manual flows that require Guira review
      if (order.approved_at) {
        traceRows.push(this.row('Aprobado por Guira el', this.fmtDate(order.approved_at)));
      }

      // Failure / rejection reason
      const failReason = order.failure_reason;
      if (failReason) {
        traceRows.push(this.row('Motivo Rechazo', this.toDisplay(failReason), { color: COLORS.destructive }));
      }

      // ── Build document ────────────────────────────────

      // Formal bordered-table layout for sections
      const borderedLayout = {
        hLineWidth: (i: number, node: any) => 0.6,
        vLineWidth: (i: number, node: any) => (i === 0 || i === node.table.widths.length ? 0.6 : 0),
        hLineColor: () => COLORS.border,
        vLineColor: () => COLORS.border,
        paddingLeft: () => 10,
        paddingRight: () => 10,
        paddingTop: () => 6,
        paddingBottom: () => 6,
      };

      // Section header row (navy bg, white text, spans full table)
      const sectionHeader = (title: string, cols: number) => {
        const cells: any[] = [{ text: title, style: 'sectionHeader', colSpan: cols }];
        for (let i = 1; i < cols; i++) cells.push({});
        return cells;
      };

      // ── Sección 1: CLIENTE Y BENEFICIARIO (grid 4 cols) ──
      const identityLabel = client?.identity_label ?? null;
      const identityValue = client?.identity_value ?? null;
      const countryDisplay = client?.country ? this.resolveCountryName(client.country) : null;

      // Filas del cliente (columna izquierda del grid)
      const clientRows: any[][] = [];
      clientRows.push([
        { text: 'Nombre / Razón Social', style: 'tLabel' },
        { text: this.toDisplay(client?.full_name), style: 'tValue' },
      ]);
      if (identityLabel && identityValue) {
        clientRows.push([
          { text: identityLabel, style: 'tLabel' },
          { text: this.toDisplay(identityValue), style: 'tValue' },
        ]);
      }
      if (countryDisplay) {
        clientRows.push([
          { text: 'País', style: 'tLabel' },
          { text: countryDisplay, style: 'tValue' },
        ]);
      }
      clientRows.push(
        [{ text: 'Correo Electrónico', style: 'tLabel' }, { text: this.toDisplay(client?.email), style: 'tValue' }],
        [{ text: 'Teléfono', style: 'tLabel' }, { text: this.toDisplay(client?.phone), style: 'tValue' }],
      );

      const isBeneficiaryOnlyFlow = ['fiat_bo_to_bridge_wallet', 'crypto_to_bridge_wallet'].includes(ft);

      const partyTable = isBeneficiaryOnlyFlow
        ? {
            table: {
              headerRows: 1,
              widths: ['30%', '70%'],
              body: [
                sectionHeader('BENEFICIARIO', 2),
                ...clientRows,
              ],
            },
            layout: borderedLayout,
            margin: [0, 0, 0, 14] as [number, number, number, number],
          }
        : {
            table: {
              headerRows: 1,
              widths: ['25%', '25%', '25%', '25%'],
              body: [
                sectionHeader('CLIENTE Y BENEFICIARIO', 4),
                [
                  { text: 'ORDENANTE / CLIENTE', style: 'subHeader', colSpan: 2 }, {},
                  { text: 'BENEFICIARIO', style: 'subHeader', colSpan: 2 }, {},
                ],
                ...this.mergeColumns(clientRows, beneficiarySummaryRows),
              ],
            },
            layout: {
              ...borderedLayout,
              vLineWidth: (i: number, node: any) => {
                if (i === 0 || i === node.table.widths.length) return 0.6;
                if (i === 2) return 0.4;
                return 0;
              },
              vLineColor: (i: number) => i === 2 ? COLORS.borderLight : COLORS.border,
            },
            margin: [0, 0, 0, 14] as [number, number, number, number],
          };

      // ── Sección 2: DATOS BANCARIOS DEL BENEFICIARIO ──
      const bankingTable = {
        table: {
          headerRows: 1,
          widths: ['30%', '70%'],
          body: [
            sectionHeader('DATOS BANCARIOS DEL BENEFICIARIO', 2),
            ...bankingRows,
          ],
        },
        layout: borderedLayout,
        margin: [0, 0, 0, 14] as [number, number, number, number],
      };

      // ── Sección 3: DETALLES DE LA OPERACIÓN ──
      const operationDetailTable = {
        table: {
          headerRows: 1,
          widths: ['30%', '70%'],
          body: [
            sectionHeader('DETALLES DE LA OPERACIÓN', 2),
            ...operationRows,
          ],
        },
        layout: borderedLayout,
        margin: [0, 0, 0, 14] as [number, number, number, number],
      };

      // ── Traceability table ──
      const traceTable = {
        table: {
          headerRows: 1,
          widths: ['30%', '70%'],
          body: [
            sectionHeader('TRAZABILIDAD Y REFERENCIAS', 2),
            ...this.filterNd(traceRows),
          ],
        },
        layout: borderedLayout,
        margin: [0, 0, 0, 20] as [number, number, number, number],
      };

      const docDefinition: TDocumentDefinitions = {
        pageSize: 'A4',
        pageMargins: [36, 36, 36, 60],
        defaultStyle: { font: 'Helvetica', fontSize: 9, color: COLORS.text },

        content: [
          // ═══ HEADER BAND (navy) ═══
          {
            table: {
              widths: ['*'],
              body: [[
                {
                  columns: [
                    {
                      stack: [
                        { ...logo, margin: [0, 2, 0, 0] },
                        { text: 'Plataforma de Operaciones Interbancarias', style: 'headerTagline', margin: [0, 6, 0, 0] },
                      ],
                      width: 'auto',
                    },
                    {
                      stack: [
                        { text: 'COMPROBANTE DE TRANSACCIÓN', style: 'headerTitle' },
                        // La micro-etiqueta es lo que permite a un tercero (banca
                        // corresponsal, auditoría) leer la línea siguiente como el
                        // tipo de operación y no como un lema comercial.
                        { text: 'TIPO DE SERVICIO', style: 'headerLabel', margin: [0, 7, 0, 0] },
                        { text: flowLabel, style: 'headerSubtitle', margin: [0, 2, 0, 0] },
                      ],
                      alignment: 'right' as const,
                    },
                  ],
                  fillColor: COLORS.navy,
                  margin: [20, 16, 20, 16],
                },
              ]],
            },
            layout: 'noBorders',
            margin: [0, 0, 0, 0],
          },

          // ═══ ACCENT STRIPE (thin teal line) ═══
          {
            canvas: [{ type: 'rect', x: 0, y: 0, w: 523, h: 3, color: COLORS.accent }],
            margin: [0, 0, 0, 14],
          },

          // ═══ META ROW — bordered cells ═══
          {
            table: {
              widths: ['40%', '30%', '30%'],
              body: [[
                {
                  stack: [
                    { text: 'N° DE OPERACIÓN', style: 'metaLabel' },
                    { text: order.id ?? 'N/D', style: 'metaId' },
                  ],
                  margin: [8, 6, 8, 6],
                },
                {
                  stack: [
                    { text: 'FECHA DE EMISIÓN', style: 'metaLabel' },
                    { text: this.fmtDate(order.created_at), style: 'metaValue', fontSize: 8 },
                  ],
                  margin: [8, 6, 8, 6],
                },
                {
                  stack: [
                    { text: 'ESTADO', style: 'metaLabel' },
                    { text: statusLabel, style: 'metaValue', color: stColor, bold: true, fontSize: 11 },
                  ],
                  margin: [8, 6, 8, 6],
                  alignment: 'right' as const,
                },
              ]],
            },
            layout: {
              hLineWidth: () => 0.5,
              vLineWidth: (i: number, node: any) => (i === 0 || i === node.table.widths.length ? 0.5 : 0.3),
              hLineColor: () => COLORS.border,
              vLineColor: () => COLORS.border,
            },
            margin: [0, 0, 0, 14],
          },

          // ═══ AMOUNT PANEL ═══
          {
            table: {
              widths: ['*'],
              body: [[
                {
                  columns: [
                    {
                      stack: [
                        { text: 'MONTO ACREDITADO', style: 'amountLabel' },
                        { text: amountDestText, style: 'amountValue' },
                      ],
                      width: '*',
                    },
                    {
                      stack: [
                        { text: 'MONTO ORDENADO', style: 'amountLabel' },
                        { text: amountOriginText, style: 'amountOrigin' },
                      ],
                      // 'auto' basta: ambas caras son cifras cortas de una línea,
                      // a diferencia de la etiqueta de flujo que ocupaba este hueco
                      // y exigía un ancho fijo de 190pt.
                      width: 'auto',
                      alignment: 'right' as const,
                    },
                  ],
                  fillColor: COLORS.surface,
                  margin: [16, 12, 16, 12],
                },
              ]],
            },
            layout: {
              hLineWidth: () => 0.6,
              vLineWidth: () => 0.6,
              hLineColor: () => COLORS.border,
              vLineColor: () => COLORS.border,
            },
            margin: [0, 0, 0, 16],
          },

          // ═══ SECTION TABLES ═══
          partyTable,
          bankingTable,
          operationDetailTable,
          traceTable,

          // ═══ ACCENT BOTTOM LINE ═══
          {
            canvas: [{ type: 'rect', x: 0, y: 0, w: 523, h: 2, color: COLORS.accent }],
            margin: [0, 0, 0, 12],
          },

          // ═══ LEGAL DISCLAIMER ═══
          this.buildLegalNotice(),
        ],

        // ═══ FOOTER ═══
        footer: (currentPage, pageCount) => ({
          columns: [
            {
              stack: [
                { text: 'Guira — Plataforma de Operaciones Interbancarias', style: 'footerBrand' },
                { text: 'www.guiracorp.com  |  soporte@guiracorp.com', style: 'footerContact' },
              ],
              alignment: 'left' as const,
            },
            {
              text: `Página ${currentPage} de ${pageCount}`,
              style: 'footerPage',
              alignment: 'right' as const,
            },
          ],
          margin: [36, 0, 36, 0],
        }),

        // ═══ STYLES ═══
        styles: {
          // Header
          brandFallback: { fontSize: 20, bold: true, color: COLORS.white },
          headerTitle: { fontSize: 14, bold: true, color: COLORS.white, characterSpacing: 1.2 },
          headerSubtitle: { fontSize: 9, color: COLORS.accent, characterSpacing: 0.3 },
          headerLabel: { fontSize: 6.5, bold: true, color: COLORS.mutedOnNavy, characterSpacing: 0.9 },
          headerTagline: { fontSize: 7, color: COLORS.mutedOnNavy, characterSpacing: 0.4 },

          // Meta cells
          metaLabel: { fontSize: 7.5, bold: true, color: COLORS.muted, characterSpacing: 0.8, margin: [0, 0, 0, 3] },
          metaId: { fontSize: 7.5, color: COLORS.text, characterSpacing: 0.2 },
          metaValue: { fontSize: 9.5, color: COLORS.text },

          // Amount panel
          amountLabel: { fontSize: 7.5, bold: true, color: COLORS.muted, characterSpacing: 0.8, margin: [0, 0, 0, 4] },
          amountValue: { fontSize: 20, bold: true, color: COLORS.navy },
          // Deliberadamente menor que amountValue: el monto acreditado manda,
          // el origen es contexto.
          amountOrigin: { fontSize: 13, bold: true, color: COLORS.textSecondary },

          // Section tables
          sectionHeader: { fontSize: 9, bold: true, color: COLORS.white, fillColor: COLORS.navy, characterSpacing: 1 },
          subHeader: { fontSize: 8, bold: true, color: COLORS.primary, characterSpacing: 0.6, margin: [0, 2, 0, 2] },
          cellLabel: { fontSize: 8, color: COLORS.muted },
          cellValue: { fontSize: 9, color: COLORS.text, bold: true },

          // Detail tables (origin, dest, trace)
          tLabel: { fontSize: 8.5, color: COLORS.muted },
          tValue: { fontSize: 9, color: COLORS.text, bold: true },

          // Legal / Footer
          legalHeading: { fontSize: 7, bold: true, color: COLORS.navy, characterSpacing: 0.8, margin: [0, 0, 0, 5] },
          disclaimer: { fontSize: 7, color: COLORS.muted, lineHeight: 1.4, margin: [0, 0, 0, 0] },
          footerBrand: { fontSize: 7.5, bold: true, color: COLORS.navy },
          footerContact: { fontSize: 7, color: COLORS.muted, margin: [0, 1, 0, 0] },
          footerPage: { fontSize: 7.5, color: COLORS.muted },
        },
      };

      const pdf = this.printer.createPdf(docDefinition);
      return await pdf.getBuffer();
    } catch (error) {
      this.logger.error('Error generando PDF', error);
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  C.T.A.V. — Comprobante de Transferencia de Activos Virtuales
  //  Paleta teal institucional.
  // ═══════════════════════════════════════════════════════════

  async generatePsavReceiptPdf(
    order: any,
    psavAgent: { id: string; name: string },
    client: {
      full_name: string;
      email: string;
      phone?: string | null;
      identity_label: string;
      identity_value: string;
      nit?: string | null;
      is_company: boolean;
    },
    ctavId: string,
    liquidationAddress?: { address: string; chain?: string | null } | null,
  ): Promise<Buffer> {
    const C = {
      headerBg: '#1C3A3A',
      headerText: '#FFFFFF',
      headerSub: '#A8CCCA',
      accent: '#00968A',
      sectionBg: '#1A2E2E',
      sectionText: '#FFFFFF',
      summaryBg: '#D6EEEC',
      summaryLbl: '#4A7A75',
      body: '#1A1A1A',
      label: '#888888',
      border: '#CCCCCC',
      rowAlt: '#F5F5F5',
      white: '#FFFFFF',
    };

    const nd = (val: any) => (val == null || val === '' ? 'N/D' : String(val));
    const emitDate = this.fmtDate(new Date().toISOString());
    const createdDate = this.fmtDate(order.created_at);
    const completedDate = order.completed_at ? this.fmtDate(order.completed_at) : emitDate;
    const ctavStatusUpper = this.toDisplay(order.status).toUpperCase();
    const ctavStatusLabel = STATUS_LABELS[ctavStatusUpper] ?? ctavStatusUpper;
    const ctavStatusColor = this.statusColor(ctavStatusUpper);
    const refCode = nd(order.deposit_reference_code);
    const ctavShort = `N° CTAV-${ctavId.slice(0, 8).toUpperCase()}`;

    // Detectar flujo: world_to_bolivia (origen divisa extranjera, destino BOB)
    const isWorldToBolivia = (order.currency ?? 'BOB').toUpperCase() !== 'BOB' &&
                              (order.destination_currency ?? '').toUpperCase() === 'BOB';

    const currency = (order.currency ?? 'BOB').toUpperCase();
    const destCcy = (order.destination_currency ?? '').toUpperCase();
    const exRate = nd(order.exchange_rate_applied);

    // Para world_to_bolivia: amountBob es monto en divisa origen, amountDest es monto en BOB
    // Para flujos BOB→Cripto: amountBob es monto BOB, amountDest es monto cripto
    const amountOrigin = this.fmtAmount(order.amount);
    const amountDest = this.fmtAmount(order.amount_destination ?? order.net_amount);

    // Variables formateadas según el flujo
    const amountDisplay = isWorldToBolivia
      ? `${amountOrigin} ${currency}`  // ej: "1000.00 USD"
      : `Bs. ${amountOrigin}`;         // ej: "Bs. 1000.00"

    const amountDestDisplay = isWorldToBolivia
      ? `Bs. ${amountDest}`            // ej: "Bs. 7186.94"
      : `${amountDest} ${destCcy}`;    // ej: "100.00 USDT"

    const exRateDisplay = isWorldToBolivia
      ? `${exRate} ${currency}/BOB`     // ej: "7.5652 USD/BOB"
      : exRate;                         // ej: "6.96"

    const destNet = nd(order.destination_network);
    const txRef = nd(order.tx_hash ?? order.source_tx_hash);
    const walletDest = nd(liquidationAddress?.address);

    // ── Layout helpers ──
    const borderedLayout = {
      hLineWidth: () => 0.5,
      vLineWidth: (i: number, node: any) => (i === 0 || i === node.table.widths.length ? 0.5 : 0),
      hLineColor: () => C.border,
      vLineColor: () => C.border,
      paddingLeft: () => 10,
      paddingRight: () => 10,
      paddingTop: () => 5,
      paddingBottom: () => 5,
    };

    const fullBorderLayout = {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => C.border,
      vLineColor: () => C.border,
      paddingLeft: () => 10,
      paddingRight: () => 10,
      paddingTop: () => 5,
      paddingBottom: () => 5,
    };

    const secHdr = (text: string, cols: number): any[] => {
      const cells: any[] = [{
        text,
        fontSize: 7.5,
        bold: true,
        color: C.sectionText,
        fillColor: C.sectionBg,
        characterSpacing: 0.8,
        colSpan: cols,
        margin: [2, 4, 2, 4],
      }];
      for (let i = 1; i < cols; i++) cells.push({});
      return cells;
    };

    const dr = (label: string, value: string, alt = false): any[] => [
      { text: label, fontSize: 7.5, color: C.label, fillColor: alt ? C.rowAlt : C.white },
      { text: value, fontSize: 8.5, bold: true, color: C.body, fillColor: alt ? C.rowAlt : C.white },
    ];

    // ── Sección 3: Datos del cliente ──
    const clientRows: any[][] = [secHdr('DATOS DEL CLIENTE', 2)];
    clientRows.push(dr('Nombre / Razón Social', nd(client.full_name)));
    clientRows.push(dr(client.identity_label, nd(client.identity_value), true));
    if (client.nit) clientRows.push(dr('NIT', client.nit));
    clientRows.push(dr('Correo Electrónico', nd(client.email), !!client.nit));
    if (client.phone) clientRows.push(dr('Teléfono', client.phone, !client.nit));

    // ── Sección 4: Detalles (grid 4 columnas) ──
    // Para world_to_bolivia: mostrar cuenta bancaria destino
    // Para flujos BOB→Cripto: mostrar wallet blockchain
    const detailRows: any[][] = [
      secHdr('DETALLES DE LA OPERACIÓN', 4),
    ];

    if (isWorldToBolivia) {
      // world_to_bolivia: mostrar datos bancarios destino
      detailRows.push([
        { text: 'Monto Acreditado', fontSize: 7.5, color: C.label, fillColor: C.white },
        { text: amountDestDisplay, fontSize: 8.5, bold: true, color: C.body, fillColor: C.white },
        { text: 'Referencia', fontSize: 7.5, color: C.label, fillColor: C.white },
        { text: refCode, fontSize: 8.5, bold: true, color: C.body, fillColor: C.white },
      ]);
      detailRows.push([
        { text: 'Banco Destino', fontSize: 7.5, color: C.label, fillColor: C.rowAlt },
        { text: nd(order.destination_bank_name), fontSize: 8.5, bold: true, color: C.body, fillColor: C.rowAlt, colSpan: 3 },
        {}, {},
      ]);
      detailRows.push([
        { text: 'Cuenta Destino', fontSize: 7.5, color: C.label, fillColor: C.white },
        { text: nd(order.destination_account_number), fontSize: 8.5, bold: true, color: C.body, fillColor: C.white },
        { text: 'Titular', fontSize: 7.5, color: C.label, fillColor: C.white },
        { text: nd(order.destination_account_holder), fontSize: 8.5, bold: true, color: C.body, fillColor: C.white },
      ]);
    } else {
      // Flujos BOB→Cripto: mostrar wallet blockchain
      detailRows.push([
        { text: 'Monto Acreditado', fontSize: 7.5, color: C.label, fillColor: C.white },
        { text: amountDestDisplay, fontSize: 8.5, bold: true, color: C.body, fillColor: C.white },
        { text: 'Red / Blockchain', fontSize: 7.5, color: C.label, fillColor: C.white },
        { text: destNet, fontSize: 8.5, bold: true, color: C.body, fillColor: C.white },
      ]);
      detailRows.push([
        { text: 'Wallet Destino', fontSize: 7.5, color: C.label, fillColor: C.rowAlt },
        { text: walletDest, fontSize: 7, bold: true, color: C.body, fillColor: C.rowAlt, colSpan: 3 },
        {}, {},
      ]);
      detailRows.push([
        { text: 'Hash / ID Transacción', fontSize: 7.5, color: C.label, fillColor: C.white },
        { text: txRef, fontSize: 7, bold: true, color: C.body, fillColor: C.white, colSpan: 3 },
        {}, {},
      ]);
    }

    const docDefinition: TDocumentDefinitions = {
      pageSize: 'A4',
      pageMargins: [40, 40, 40, 55],
      defaultStyle: { font: 'Helvetica', fontSize: 9, color: C.body },

      content: [

        // ── 1. CABECERA ──
        {
          table: {
            widths: ['*'],
            body: [[{
              columns: [
                {
                  stack: [
                    { text: 'C.T.A.V.', fontSize: 20, bold: true, color: C.headerText, characterSpacing: 1 },
                    { text: 'Comprobante de Transferencia de Activos Virtuales', fontSize: 7.5, color: C.headerSub, margin: [0, 3, 0, 0] },
                  ],
                  width: '*',
                },
                {
                  stack: [
                    { text: 'COMPROBANTE DE OPERACIÓN', fontSize: 12, bold: true, color: C.headerText, characterSpacing: 0.4, alignment: 'right' as const },
                    { text: 'Compra de activos virtuales por PSAV', fontSize: 7.5, color: C.headerSub, alignment: 'right' as const, margin: [0, 3, 0, 0] },
                    { text: ctavShort, fontSize: 9.5, bold: true, color: C.accent, alignment: 'right' as const, margin: [0, 5, 0, 0] },
                  ],
                  width: 'auto',
                },
              ],
              fillColor: C.headerBg,
              margin: [18, 16, 18, 16],
            }]],
          },
          layout: 'noBorders',
          margin: [0, 0, 0, 0] as [number, number, number, number],
        },

        // Línea acento teal
        {
          canvas: [{ type: 'rect', x: 0, y: 0, w: 515, h: 3, color: C.accent }],
          margin: [0, 0, 0, 14] as [number, number, number, number],
        },

        // ── 2. BARRA DE ESTADO (3 columnas) ──
        {
          table: {
            widths: ['33%', '33%', '34%'],
            body: [[
              {
                stack: [
                  { text: 'FECHA DE EMISIÓN', fontSize: 7, bold: true, color: C.label, characterSpacing: 0.6 },
                  { text: completedDate, fontSize: 8.5, bold: true, color: C.body, margin: [0, 3, 0, 0] },
                ],
                border: [true, true, true, true],
                margin: [0, 6, 0, 6],
              },
              {
                stack: [
                  { text: 'ESTADO', fontSize: 7, bold: true, color: C.label, characterSpacing: 0.6 },
                  { text: ctavStatusLabel, fontSize: 8.5, bold: true, color: ctavStatusColor, margin: [0, 3, 0, 0] },
                ],
                border: [true, true, true, true],
                margin: [0, 6, 0, 6],
              },
              {
                stack: [
                  { text: 'CÓDIGO DE RASTREO', fontSize: 7, bold: true, color: C.label, characterSpacing: 0.6 },
                  { text: refCode, fontSize: 8.5, bold: true, color: C.body, margin: [0, 3, 0, 0] },
                ],
                border: [true, true, true, true],
                margin: [0, 6, 0, 6],
              },
            ]],
          },
          layout: fullBorderLayout,
          margin: [0, 0, 0, 12] as [number, number, number, number],
        },

        // ── 3. RESUMEN DESTACADO (fondo teal claro) ──
        {
          table: {
            widths: ['*', '*', '*'],
            body: [[
              {
                stack: [
                  {
                    text: isWorldToBolivia
                      ? 'MONTO ENVIADO DESDE EL EXTERIOR'
                      : 'MONTO TRANSFERIDO POR EL CLIENTE',
                    fontSize: 6.5,
                    bold: true,
                    color: C.summaryLbl,
                    characterSpacing: 0.5,
                  },
                  { text: amountDisplay, fontSize: 20, bold: true, color: C.sectionBg, margin: [0, 3, 0, 0] },
                ],
                fillColor: C.summaryBg,
                border: [true, true, false, true],
                margin: [4, 8, 4, 8],
              },
              {
                stack: [
                  { text: 'TIPO DE CAMBIO APLICADO', fontSize: 6.5, bold: true, color: C.summaryLbl, characterSpacing: 0.5 },
                  { text: exRateDisplay, fontSize: 14, bold: true, color: C.sectionBg, margin: [0, 6, 0, 0], decoration: 'underline' as const },
                ],
                fillColor: C.summaryBg,
                border: [false, true, false, true],
                margin: [4, 8, 4, 8],
              },
              {
                stack: [
                  {
                    text: isWorldToBolivia
                      ? 'MONTO ACREDITADO EN BOB'
                      : 'ACTIVO VIRTUAL ADQUIRIDO',
                    fontSize: 6.5,
                    bold: true,
                    color: C.summaryLbl,
                    characterSpacing: 0.5,
                  },
                  { text: amountDestDisplay, fontSize: 14, bold: true, color: C.sectionBg, margin: [0, 6, 0, 0], decoration: 'underline' as const },
                ],
                fillColor: C.summaryBg,
                border: [false, true, true, true],
                margin: [4, 8, 4, 8],
              },
            ]],
          },
          layout: fullBorderLayout,
          margin: [0, 0, 0, 12] as [number, number, number, number],
        },

        // ── 4. DATOS DEL CLIENTE ──
        {
          table: {
            widths: ['35%', '65%'],
            body: clientRows,
          },
          layout: borderedLayout,
          margin: [0, 0, 0, 12] as [number, number, number, number],
        },

        // ── 5. DETALLES DE LA OPERACIÓN ──
        {
          table: {
            widths: ['*'],
            body: [[{
              stack: [
                { text: 'DETALLES DE LA OPERACIÓN', fontSize: 7.5, bold: true, color: C.sectionText, characterSpacing: 0.8, margin: [0, 0, 0, 0] },
              ],
              fillColor: C.sectionBg,
              border: [true, true, true, false],
              margin: [2, 4, 2, 4],
            }]],
          },
          layout: 'noBorders',
          margin: [0, 0, 0, 0] as [number, number, number, number],
        },
        // Párrafo narrativo (condicional según flujo)
        {
          table: {
            widths: ['*'],
            body: [[{
              text: isWorldToBolivia ? [
                'Se deja constancia de que el PSAV ',
                { text: psavAgent.name, bold: true },
                ' recibió la suma de ',
                { text: amountDisplay, bold: true },
                ' en favor de ',
                { text: nd(client.full_name), bold: true },
                ', aplicando el tipo de cambio de ',
                { text: exRateDisplay, bold: true },
                ' y acreditando en su cuenta bancaria la suma de ',
                { text: amountDestDisplay, bold: true },
                '.',
              ] : [
                'Se deja constancia de que el PSAV ',
                { text: psavAgent.name, bold: true },
                ' realizó la compra de ',
                { text: destCcy, bold: true },
                ' en favor de ',
                { text: nd(client.full_name), bold: true },
                ', por la suma transferida de ',
                { text: amountDisplay, bold: true },
                ', aplicando el tipo de cambio vigente/referencial de ',
                { text: exRateDisplay, bold: true },
                ' de fecha ',
                { text: createdDate, bold: true },
                '.',
              ],
              fontSize: 8.5,
              lineHeight: 1.5,
              color: C.body,
              border: [true, false, true, false],
              margin: [10, 8, 10, 8] as [number, number, number, number],
            }]],
          },
          margin: [0, 0, 0, 0] as [number, number, number, number],
        },
        // Grid 4 columnas
        {
          table: {
            widths: ['22%', '28%', '22%', '28%'],
            body: detailRows.slice(1),
          },
          layout: fullBorderLayout,
          margin: [0, 0, 0, 12] as [number, number, number, number],
        },

        // ── 6. TRAZABILIDAD ──
        {
          table: {
            widths: ['35%', '65%'],
            body: [
              secHdr('TRAZABILIDAD', 2),
              dr('Completado en fecha', completedDate),
            ],
          },
          layout: borderedLayout,
          margin: [0, 0, 0, 12] as [number, number, number, number],
        },

        // ── 7. EMITIDO POR / PSAV ──
        {
          table: {
            widths: ['*'],
            body: [[{
              columns: [
                { text: 'Emitido por / PSAV:', fontSize: 7.5, bold: true, color: C.label, width: 'auto' },
                { text: psavAgent.name, fontSize: 8.5, bold: true, color: C.body, margin: [8, 0, 0, 0], width: '*' },
              ],
              margin: [10, 7, 10, 7],
              fillColor: C.rowAlt,
            }]],
          },
          layout: fullBorderLayout,
          margin: [0, 0, 0, 12] as [number, number, number, number],
        },

        // Línea de cierre
        {
          canvas: [{ type: 'rect', x: 0, y: 0, w: 515, h: 1, color: C.border }],
          margin: [0, 0, 0, 8] as [number, number, number, number],
        },

        // ── 8. AVISO LEGAL ──
        {
          text: 'Aviso Legal: El presente C.T.A.V. respalda la operación realizada por el PSAV en favor del cliente. No constituye factura, comprobante fiscal, captación de recursos, intermediación financiera ni garantía de rendimiento.',
          fontSize: 6.5,
          color: C.label,
          lineHeight: 1.5,
          alignment: 'justify' as const,
        },
      ],

      footer: (_currentPage: number, _pageCount: number) => ({
        columns: [
          { text: 'C.T.A.V. — Comprobante de Transferencia de Activos Virtuales', fontSize: 6.5, color: C.label },
          { text: 'Página 1 de 1', fontSize: 6.5, color: C.label, alignment: 'right' as const },
        ],
        margin: [40, 0, 40, 0],
      }),

      styles: {},
    };

    try {
      const pdf = this.printer.createPdf(docDefinition);
      return await pdf.getBuffer();
    } catch (error) {
      this.logger.error('Error generando PDF C.T.A.V.', error);
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  EXPEDIENTE DE ONBOARDING — Resumen para envío manual a
  //  proveedores de onboarding (ej. Pythas). Las secciones y
  //  etiquetas deben reflejar buildStructuredSections() en
  //  frontend_guira_staff/features/staff/components/onboarding-detail-page.tsx
  //  — si cambian los campos allí, actualizar también aquí.
  // ═══════════════════════════════════════════════════════════

  private readonly ONBOARDING_STATUS_LABELS: Record<string, string> = {
    pending: 'Pendiente',
    in_progress: 'En progreso',
    kyc_started: 'KYC iniciado',
    kyb_started: 'KYB iniciado',
    kyc_submitted: 'KYC enviado',
    kyb_submitted: 'KYB enviado',
    in_review: 'En revisión',
    pending_bridge: 'Pendiente Bridge',
    kyc_issues: 'Con observaciones',
    bridge_rejected: 'Rechazado por Bridge',
    approved: 'Aprobado',
    rejected: 'Rechazado',
    suspended: 'Suspendido',
  };

  private readonly ONBOARDING_HIGH_RISK_LABELS: Record<string, string> = {
    adult_entertainment: 'Entretenimiento para adultos',
    gambling: 'Apuestas / Juegos de azar',
    hold_client_funds: 'Custodia de fondos de clientes',
    investment_services: 'Servicios de inversión',
    lending_banking: 'Préstamos y banca',
    marijuana_or_related_services: 'Cannabis / Marihuana',
    money_services: 'Servicios de dinero (MSB)',
    nicotine_tobacco_or_related_services: 'Tabaco / Nicotina',
    operate_foreign_exchange_virtual_currencies_brokerage_otc: 'Exchange / OTC de divisas o criptomonedas',
    pharmaceuticals: 'Farmacéutica / Medicamentos',
    precious_metals_precious_stones_jewelry: 'Metales preciosos / Joyería',
    safe_deposit_box_rentals: 'Alquiler de cajas de seguridad',
    third_party_payment_processing: 'Procesamiento de pagos de terceros',
    weapons_firearms_and_explosives: 'Armas de fuego y explosivos',
    none_of_the_above: 'Ninguna de las anteriores',
  };

  private normalizeOnboardingObject(value: unknown): Record<string, any> {
    return value && typeof value === 'object' ? (value as Record<string, any>) : {};
  }

  private obBool(value: unknown): string | null {
    return value === true ? 'Sí' : value === false ? 'No' : null;
  }

  private obHighRisk(value: unknown): string | null {
    if (!Array.isArray(value) || value.length === 0) return null;
    const labels = value
      .filter((item): item is string => typeof item === 'string' && item !== 'none_of_the_above')
      .map((item) => this.ONBOARDING_HIGH_RISK_LABELS[item] ?? item);
    return labels.length > 0 ? labels.join(', ') : null;
  }

  /** Espejo de buildStructuredSections() del frontend — mismas etiquetas en español. */
  private buildOnboardingSections(
    onboardingType: 'personal' | 'company',
    data: Record<string, any>,
  ): Array<{ title: string; rows: any[][] }> {
    const r = (label: string, value: unknown): any[] | null => {
      if (value === null || value === undefined) return null;
      if (typeof value === 'string' && value.trim() === '') return null;
      return this.row(label, this.toDisplay(value));
    };
    const compact = (rows: Array<any[] | null>) => rows.filter((row): row is any[] => row !== null);

    if (onboardingType === 'company') {
      const ubos = Array.isArray(data.ubos) ? data.ubos : [];
      const sections: Array<{ title: string; rows: any[][] }> = [
        {
          title: 'Identidad societaria',
          rows: compact([
            r('Razón social', data.company_legal_name),
            r('NIT / Tax ID', data.tax_id),
            r('Tipo de entidad', data.entity_type),
            r('Descripción de actividad', data.business_description),
            r('Sitio web', data.business_website),
            r('Correo de la empresa', data.email),
            r('Teléfono de la empresa', data.business_phone),
          ]),
        },
        {
          title: 'Dirección legal y representante',
          rows: compact([
            r('Dirección legal', data.business_street),
            r('Ciudad', data.business_city),
            r('País', data.business_country),
            r('Nombres representante', data.legal_rep_first_names),
            r('Apellidos representante', data.legal_rep_last_names),
            r('Estado / provincia representante', data.legal_rep_state),
            r('Cargo', data.legal_rep_position),
            r('Tipo de documento representante', data.legal_rep_id_type),
            r('Documento representante', data.legal_rep_id_number),
            r('Correo representante', data.legal_rep_email),
            r('Nacionalidad representante', data.legal_rep_nationality),
            r('Representante es PEP', this.obBool(data.legal_rep_is_pep)),
          ]),
        },
        {
          title: 'Perfil financiero',
          rows: compact([
            r('Propósito de la cuenta', data.purpose),
            r('Origen de fondos', data.source_of_funds),
            r('Volumen mensual estimado', data.estimated_monthly_volume),
            r('Ingresos anuales estimados', data.estimated_annual_revenue_usd),
            r('Presta servicios de dinero (MSB)', this.obBool(data.conducts_money_services)),
            r('Actividades de alto riesgo', this.obHighRisk(data.high_risk_activities)),
          ]),
        },
      ];

      ubos.forEach((ubo: any, index: number) => {
        const n = this.normalizeOnboardingObject(ubo);
        const fullName = [n.first_names, n.last_names].filter(Boolean).join(' ').trim();
        sections.push({
          title: `Beneficiario final — UBO ${index + 1}`,
          rows: compact([
            r('Nombre completo', fullName || null),
            r('Participación', n.percentage),
            r('Nacionalidad', n.nationality),
            r('Estado / provincia', n.state),
            r('Tipo de documento', n.id_type),
            r('Número de documento', n.id_number),
            r('Correo', n.email),
            r('Es PEP', this.obBool(n.is_pep)),
            r('Control operacional', this.obBool(n.has_control)),
            r('Cargo', n.position),
          ]),
        });
      });

      return sections;
    }

    return [
      {
        title: 'Identidad personal',
        rows: compact([
          r('Nombres', data.first_names),
          r('Segundo nombre', data.middle_name),
          r('Apellidos', data.last_names),
          r('Fecha de nacimiento', data.dob),
          r('Nacionalidad', data.nationality),
          r('Tipo de documento', data.id_document_type),
          r('Número de documento', data.id_number),
          r('Vencimiento del documento', data.id_expiry),
          r('Tax ID', data.tax_id),
          r('Teléfono', data.phone),
        ]),
      },
      {
        title: 'Dirección declarada',
        rows: compact([
          r('Dirección', data.street),
          r('Dirección adicional', data.street2),
          r('Ciudad', data.city),
          r('Estado / provincia', data.state_province),
          r('País', data.country),
          r('Código postal', data.postal_code),
          r('País de residencia', data.country_of_residence),
        ]),
      },
      {
        title: 'Perfil financiero',
        rows: compact([
          r('Ocupación', data.occupation),
          r('Estatus laboral', data.employment_status),
          r('Propósito de la cuenta', data.purpose),
          r('Propósito (especificación)', data.purpose_other),
          r('Origen de fondos', data.source_of_funds),
          r('Volumen mensual estimado', data.estimated_monthly_volume),
          r('Es PEP', this.obBool(data.is_pep)),
        ]),
      },
    ];
  }

  async generateOnboardingSummaryPdf(input: {
    reviewId: string;
    onboardingType: 'personal' | 'company';
    status: string;
    openedAt?: string | null;
    closedAt?: string | null;
    observations?: string | null;
    bridgeCustomerId?: string | null;
    displayName: string;
    profileEmail?: string | null;
    applicationData: Record<string, any>;
    documentsSummary: Array<{ ownerLabel: string; docTypeLabel: string; included: boolean }>;
    generatedByLabel: string;
  }): Promise<Buffer> {
    try {
      const logo = this.loadLogo();
      const typeLabel = input.onboardingType === 'company' ? 'KYB EMPRESARIAL' : 'KYC INDIVIDUAL';
      const statusLabel = this.ONBOARDING_STATUS_LABELS[input.status] ?? input.status;

      const sectionHeader = (title: string, cols: number) => {
        const cells: any[] = [{ text: title, style: 'sectionHeader', colSpan: cols }];
        for (let i = 1; i < cols; i++) cells.push({});
        return cells;
      };

      const borderedLayout = {
        hLineWidth: () => 0.6,
        vLineWidth: (i: number, node: any) => (i === 0 || i === node.table.widths.length ? 0.6 : 0),
        hLineColor: () => COLORS.border,
        vLineColor: () => COLORS.border,
        paddingLeft: () => 10,
        paddingRight: () => 10,
        paddingTop: () => 6,
        paddingBottom: () => 6,
      };

      const statusRows = this.filterNd([
        this.row('Estado KYC/KYB', statusLabel),
        this.row('Correo', this.toDisplay(input.profileEmail)),
        this.row('Fecha de envío', input.openedAt ? this.fmtDate(input.openedAt) : 'N/D'),
        this.row('Última actualización', input.closedAt ? this.fmtDate(input.closedAt) : 'N/D'),
        this.row('Bridge customer ID', this.toDisplay(input.bridgeCustomerId)),
        this.row('Observaciones del revisor', this.toDisplay(input.observations)),
      ]);

      const dataSections = this.buildOnboardingSections(input.onboardingType, input.applicationData);

      const docRows = input.documentsSummary.length > 0
        ? input.documentsSummary.map((d) => [
            { text: d.ownerLabel, style: 'tLabel' },
            { text: d.docTypeLabel, style: 'tValue' },
            {
              text: d.included ? 'Incluido en este paquete' : 'No disponible en Storage',
              style: 'tValue',
              color: d.included ? COLORS.success : COLORS.destructive,
            },
          ])
        : [[{ text: 'No se encontraron documentos asociados.', style: 'tLabel', colSpan: 3 }, {}, {}]];

      const content: any[] = [
        // ═══ HEADER BAND ═══
        {
          table: {
            widths: ['*'],
            body: [[
              {
                columns: [
                  { ...logo, margin: [0, 2, 0, 0] },
                  {
                    stack: [
                      { text: 'EXPEDIENTE DE ONBOARDING', style: 'headerTitle' },
                      { text: `${typeLabel} — ${input.displayName}`, style: 'headerSubtitle', margin: [0, 3, 0, 0] },
                    ],
                    alignment: 'right' as const,
                  },
                ],
                fillColor: COLORS.navy,
                margin: [20, 16, 20, 16],
              },
            ]],
          },
          layout: 'noBorders',
          margin: [0, 0, 0, 0],
        },
        { canvas: [{ type: 'rect', x: 0, y: 0, w: 523, h: 3, color: COLORS.accent }], margin: [0, 0, 0, 14] },

        // ═══ META ROW ═══
        {
          table: {
            widths: ['33%', '34%', '33%'],
            body: [[
              { stack: [{ text: 'ID DE EXPEDIENTE', style: 'metaLabel' }, { text: input.reviewId, style: 'metaId' }], margin: [8, 6, 8, 6] },
              { stack: [{ text: 'GENERADO EL', style: 'metaLabel' }, { text: this.fmtDate(new Date().toISOString()), style: 'metaValue', fontSize: 8 }], margin: [8, 6, 8, 6] },
              { stack: [{ text: 'GENERADO POR', style: 'metaLabel' }, { text: input.generatedByLabel, style: 'metaValue', fontSize: 8 }], margin: [8, 6, 8, 6] },
            ]],
          },
          layout: {
            hLineWidth: () => 0.5,
            vLineWidth: (i: number, node: any) => (i === 0 || i === node.table.widths.length ? 0.5 : 0.3),
            hLineColor: () => COLORS.border,
            vLineColor: () => COLORS.border,
          },
          margin: [0, 0, 0, 10],
        },

        {
          text: 'Documento generado para envío manual a proveedores de onboarding (ej. Pythas). Contiene información sensible de KYC/KYB — manejar de forma confidencial.',
          style: 'disclaimer',
          margin: [0, 0, 0, 16],
        },

        // ═══ ESTADO DEL EXPEDIENTE ═══
        {
          table: { headerRows: 1, widths: ['30%', '70%'], body: [sectionHeader('ESTADO DEL EXPEDIENTE', 2), ...statusRows] },
          layout: borderedLayout,
          margin: [0, 0, 0, 14],
        },

        // ═══ SECCIONES DE DATOS (KYC / KYB) ═══
        ...dataSections.map((section) => ({
          table: { headerRows: 1, widths: ['30%', '70%'] as const, body: [sectionHeader(section.title.toUpperCase(), 2), ...section.rows] },
          layout: borderedLayout,
          margin: [0, 0, 0, 14] as [number, number, number, number],
        })),

        // ═══ DOCUMENTOS INCLUIDOS ═══
        {
          table: {
            headerRows: 1,
            widths: ['30%', '35%', '35%'],
            body: [
              [{ text: 'TITULAR', style: 'sectionHeader' }, { text: 'TIPO DE DOCUMENTO', style: 'sectionHeader' }, { text: 'ESTADO', style: 'sectionHeader' }],
              ...docRows,
            ],
          },
          layout: borderedLayout,
          margin: [0, 0, 0, 20],
        },

        { canvas: [{ type: 'rect', x: 0, y: 0, w: 523, h: 2, color: COLORS.accent }], margin: [0, 0, 0, 12] },

        {
          text: [
            { text: 'Aviso de confidencialidad: ', bold: true },
            'Este documento contiene datos personales y sensibles de cumplimiento (KYC/KYB). Su uso está restringido a la validación de onboarding con proveedores autorizados de Guira. soporte@guiracorp.com',
          ],
          style: 'disclaimer',
          alignment: 'justify' as const,
        },
      ];

      const docDefinition: TDocumentDefinitions = {
        pageSize: 'A4',
        pageMargins: [36, 36, 36, 60],
        defaultStyle: { font: 'Helvetica', fontSize: 9, color: COLORS.text },
        content,

        footer: (currentPage, pageCount) => ({
          columns: [
            {
              stack: [
                { text: 'Guira — Plataforma de Operaciones Interbancarias', style: 'footerBrand' },
                { text: 'www.guiracorp.com  |  soporte@guiracorp.com', style: 'footerContact' },
              ],
              alignment: 'left' as const,
            },
            {
              text: `Página ${currentPage} de ${pageCount}`,
              style: 'footerPage',
              alignment: 'right' as const,
            },
          ],
          margin: [36, 0, 36, 0],
        }),

        styles: {
          brandFallback: { fontSize: 20, bold: true, color: COLORS.white },
          headerTitle: { fontSize: 14, bold: true, color: COLORS.white, characterSpacing: 1.2 },
          headerSubtitle: { fontSize: 9, color: COLORS.accent, characterSpacing: 0.3 },
          metaLabel: { fontSize: 7.5, bold: true, color: COLORS.muted, characterSpacing: 0.8, margin: [0, 0, 0, 3] },
          metaId: { fontSize: 7.5, color: COLORS.text, characterSpacing: 0.2 },
          metaValue: { fontSize: 9.5, color: COLORS.text },
          sectionHeader: { fontSize: 9, bold: true, color: COLORS.white, fillColor: COLORS.navy, characterSpacing: 1 },
          tLabel: { fontSize: 8.5, color: COLORS.muted },
          tValue: { fontSize: 9, color: COLORS.text, bold: true },
          disclaimer: { fontSize: 7, color: COLORS.muted, lineHeight: 1.4 },
          footerBrand: { fontSize: 7.5, bold: true, color: COLORS.navy },
          footerContact: { fontSize: 7, color: COLORS.muted, margin: [0, 1, 0, 0] },
          footerPage: { fontSize: 7.5, color: COLORS.muted },
        },
      };

      const pdf = this.printer.createPdf(docDefinition);
      return await pdf.getBuffer();
    } catch (error) {
      this.logger.error('Error generando PDF de resumen de onboarding', error);
      throw error;
    }
  }
}
