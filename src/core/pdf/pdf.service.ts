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
  border: '#D5D8EE',      // light border
  borderLight: '#ECEFFE', // very subtle divider
  success: '#1DB87A',
  warning: '#F5A623',
  destructive: '#E84040',
  text: '#050036',        // body text
  textSecondary: '#6B6E9E',
};

// Human-readable labels per flow_type
const FLOW_LABELS: Record<string, string> = {
  fiat_bo_to_bridge_wallet: 'Deposito BOB - Billetera Guira',
  crypto_to_bridge_wallet: 'Deposito Crypto - Billetera Guira',
  // NOTA: fiat_us_to_bridge_wallet está soportado en el PDF (label + destino) pero
  // aún NO tiene método de creación en payment-orders.service.ts (flujo planificado).
  fiat_us_to_bridge_wallet: 'Deposito USD - Billetera Guira',
  bridge_wallet_to_fiat_bo: 'Retiro Guira - Cuenta BOB',
  bridge_wallet_to_fiat_us: 'Retiro Guira - Cuenta USD',
  bridge_wallet_to_crypto: 'Retiro Guira - Wallet Crypto',
  bolivia_to_world: 'Bolivia - Exterior',
  bolivia_to_wallet: 'Bolivia - Wallet Crypto',
  wallet_to_wallet: 'Wallet - Wallet (Crypto)',
  world_to_bolivia: 'Exterior a Bolivia',
  va_deposit: 'Deposito Cuenta Virtual',
};

const STATUS_LABELS: Record<string, string> = {
  CREATED: 'Creado',
  PENDING: 'Pendiente',
  WAITING_DEPOSIT: 'Esperando Depósito',
  DEPOSIT_RECEIVED: 'Depósito Validado',
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

  /** Horizontal divider line */
  private divider(width = 515): any {
    return {
      canvas: [{ type: 'line', x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 0.75, lineColor: COLORS.border }],
      margin: [0, 0, 0, 0],
    };
  }

  // ─── Origin details (per service) ─────────────────────

  private buildOriginRows(order: any, clientWallet: any): any[][] {
    const ft = order.flow_type;
    // fiat_bo_to_bridge_wallet: source_currency stores the stablecoin, not the BOB origin.
    // Nota: amount_origin / fee_total / origin_currency NO existen como columnas en
    // payment_orders. Las columnas reales son amount, fee_amount y source_currency/currency.
    const originCcy = ft === 'fiat_bo_to_bridge_wallet'
      ? (order.currency ?? '').toUpperCase()
      : (order.source_currency ?? order.currency ?? '').toUpperCase();

    // Tipo de cambio: los flujos 1:1 (stablecoin) muestran una etiqueta explícita.
    // Estos flujos guardan exchange_rate_applied = 1.0, por lo que el chequeo de
    // stablecoin DEBE tener prioridad; de lo contrario la etiqueta nunca se mostraba
    // (el valor 1.0 hacía que siempre se imprimiera el "1" crudo).
    const STABLECOIN_FLOWS = [
      'wallet_to_wallet',
      'bridge_wallet_to_crypto',
      'bridge_wallet_to_fiat_us',
      'crypto_to_bridge_wallet',
    ];
    const exchangeRateDisplay = STABLECOIN_FLOWS.includes(ft)
      ? '1.00 (stablecoin)'
      : this.toDisplay(order.exchange_rate_applied);

    const rows: any[][] = [
      this.row('Monto Origen', `${this.fmtAmount(order.amount)} ${originCcy}`),
      this.row('Comisión', `${this.fmtAmount(order.fee_amount)} ${originCcy}`),
      this.row('Tipo de Cambio', exchangeRateDisplay),
    ];

    // ── Off-ramp flows: show source Bridge wallet ──────────
    if (['bridge_wallet_to_fiat_bo', 'bridge_wallet_to_fiat_us', 'bridge_wallet_to_crypto'].includes(ft)) {
      rows.push(
        this.linkRow('Billetera Origen', this.truncateAddress(clientWallet?.address), this.buildExplorerUrl(clientWallet?.address, clientWallet?.network, 'address')),
        this.row('Red Origen', this.toDisplay(clientWallet?.network)),
      );
    }

    // ── crypto_to_bridge_wallet: network + sender address ──
    if (ft === 'crypto_to_bridge_wallet') {
      rows.push(
        this.row('Red de Depósito', this.toDisplay(order.source_network)),
      );
      // source_address = the external crypto wallet that sent funds to Bridge
      if (order.source_address) {
        rows.push(this.linkRow('Dirección de Depósito', this.truncateAddress(order.source_address), this.buildExplorerUrl(order.source_address, order.source_network, 'address')));
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
        rows.push(this.row('Comision Guira', `${this.fmtAmount(bridgeFee)} ${order.source_currency ?? ''}`));
      }
    }

    // ── wallet_to_wallet: actual sending address from DB ──
    if (ft === 'wallet_to_wallet') {
      // source_address from DB is the actual sending external wallet (more accurate than clientWallet)
      const srcAddr = order.source_address ?? clientWallet?.address;
      const srcNet = order.source_network ?? clientWallet?.network;
      rows.push(
        this.row('Red Origen', this.toDisplay(srcNet)),
        this.linkRow('Billetera Origen', this.truncateAddress(srcAddr), this.buildExplorerUrl(srcAddr, srcNet, 'address')),
      );
    }

    return rows;
  }

  // ─── Destination details (per service) ────────────────

  private buildDestinationRows(order: any, supplier: any, clientWallet: any): any[][] {
    const rows: any[][] = [];
    const ft = order.flow_type;

    // Purpose (common to all)
    const purpose = order.business_purpose;
    if (purpose) rows.push(this.row('Propósito', this.toDisplay(purpose)));

    // ── bolivia_to_world ─────────────────────────────────
    if (ft === 'bolivia_to_world') {
      rows.push(
        this.row('Proveedor', this.toDisplay(supplier?.name ?? 'No asignado')),
        this.row('Banco Destino', this.toDisplay(order.destination_bank_name)),
        this.row('Cuenta Destino', this.toDisplay(order.destination_account_number)),
        this.row('Titular', this.toDisplay(order.destination_account_holder)),
        this.row('Moneda Destino', this.toDisplay(order.destination_currency)),
      );
    }

    // ── world_to_bolivia ─────────────────────────────────
    else if (ft === 'world_to_bolivia') {
      rows.push(
        this.row('Banco Destino', this.toDisplay(order.destination_bank_name)),
        this.row('Cuenta Destino', this.toDisplay(order.destination_account_number)),
        this.row('Titular', this.toDisplay(order.destination_account_holder)),
      );
    }

    // ── bolivia_to_wallet / wallet_to_wallet ─────────────
    else if (['bolivia_to_wallet', 'wallet_to_wallet'].includes(ft)) {
      const walletAddr = supplier?.bank_details?.wallet_address ?? order.destination_address;
      const walletNet = supplier?.bank_details?.wallet_network ?? order.destination_network;
      rows.push(
        this.row('Proveedor', this.toDisplay(supplier?.name ?? 'No asignado')),
        this.linkRow('Wallet Destino', this.truncateAddress(walletAddr), this.buildExplorerUrl(walletAddr, walletNet, 'address')),
        this.row('Red Destino', this.toDisplay(walletNet)),
        this.row('Moneda Destino', this.toDisplay(supplier?.bank_details?.wallet_currency ?? order.destination_currency)),
      );
    }

    // ── On-ramps: fiat/crypto/usd → bridge_wallet ─────────
    else if (['fiat_bo_to_bridge_wallet', 'crypto_to_bridge_wallet', 'fiat_us_to_bridge_wallet'].includes(ft)) {
      rows.push(
        this.linkRow('Billetera Destino', this.truncateAddress(clientWallet?.address), this.buildExplorerUrl(clientWallet?.address, clientWallet?.network, 'address')),
        this.row('Red Destino', this.toDisplay(clientWallet?.network)),
      );
    }

    // ── va_deposit (Virtual Account / Cuenta Virtual) ─────
    else if (ft === 'va_deposit') {
      const destCcy = (order.destination_currency ?? order.currency ?? 'USDC').toUpperCase();
      rows.push(
        this.row('Canal de Depósito', 'Cuenta Virtual (ACH / Wire)'),
        this.row('Moneda Recibida', destCcy),
      );
      if (order.sender_name) {
        rows.push(this.row('Remitente', this.toDisplay(order.sender_name)));
      }
      if (order.va_deposit_status) {
        rows.push(this.row('Estado del Depósito', this.toDisplay(order.va_deposit_status)));
      }
    }

    // ── bridge_wallet_to_fiat_bo ─────────────────────────
    else if (ft === 'bridge_wallet_to_fiat_bo') {
      // Primary source: dedicated columns populated at order creation
      const bankName = order.destination_bank_name;
      const acctNum = order.destination_account_number ?? order.destination_address;
      const holder = order.destination_account_holder;
      rows.push(
        this.row('Banco Destino', this.toDisplay(bankName)),
        this.row('Cuenta Destino', this.toDisplay(acctNum)),
      );
      if (holder) rows.push(this.row('Titular', this.toDisplay(holder)));
      rows.push(this.row('Moneda Destino', this.toDisplay(order.destination_currency ?? 'BOB')));
    }

    // ── bridge_wallet_to_fiat_us ─────────────────────────
    else if (ft === 'bridge_wallet_to_fiat_us') {
      // bank_details guarda los datos ACH directamente (NO existe un sub-objeto `ach`).
      // order.destination_account_number se guarda ENMASCARADO (****1234), por lo que
      // preferimos el número completo de supplier.bank_details para el comprobante.
      const bd: any = supplier?.bank_details ?? {};
      let bankName = order.destination_bank_name || bd.bank_name || '';
      let acctNum = bd.account_number || order.destination_account_number || order.destination_address || '';
      const routing = bd.routing_number || '';
      let holder = order.destination_account_holder
        || bd.business_name
        || [bd.first_name, bd.last_name].filter(Boolean).join(' ')
        || supplier?.name
        || '';

      // Último recurso: supplier.external_accounts
      if (!bankName && supplier?.external_accounts?.length) {
        const ext = supplier.external_accounts.find((a: any) => a.id === order.external_account_id);
        if (ext) {
          bankName = ext.bank_name || '';
          if (!acctNum) acctNum = ext.account_number || '';
          if (!holder) holder = ext.account_holder_name || '';
        }
      }

      rows.push(
        this.row('Banco Destino', this.toDisplay(bankName)),
        this.row('Cuenta Destino', this.toDisplay(acctNum)),
      );
      if (routing) rows.push(this.row('Routing Number', routing));
      if (holder) rows.push(this.row('Titular', holder));
      rows.push(this.row('Moneda Destino', this.toDisplay(order.destination_currency ?? 'USD')));
    }

    // ── bridge_wallet_to_crypto ──────────────────────────
    else if (ft === 'bridge_wallet_to_crypto') {
      const destAddr = order.destination_address;
      const destNet = order.destination_network;
      rows.push(
        this.linkRow('Wallet Destino', this.truncateAddress(destAddr), this.buildExplorerUrl(destAddr, destNet, 'address')),
        this.row('Red Destino', this.toDisplay(destNet)),
        this.row('Moneda Destino', this.toDisplay(order.destination_currency)),
      );
    }

    // ── Generic fallback ─────────────────────────────────
    else {
      rows.push(
        this.row('Dirección Destino', this.toDisplay(order.destination_address)),
      );
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
      'fiat_bo_to_bridge_wallet', 'fiat_us_to_bridge_wallet',
      // va_deposit: el stablecoin acreditado es la moneda destino (p.ej. USDC)
      'va_deposit',
    ].includes(order.flow_type)) {
      return order.destination_currency ?? order.currency ?? 'N/D';
    }
    // Off-ramps to fiat: stablecoin is the source (stored in currency column)
    if (['bridge_wallet_to_fiat_bo', 'bridge_wallet_to_fiat_us'].includes(order.flow_type)) {
      return (order.currency ?? order.source_currency ?? 'N/D').toUpperCase();
    }
    return 'N/D';
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
      const statusUpper = this.toDisplay(order.status).toUpperCase();
      const statusLabel = STATUS_LABELS[statusUpper] ?? statusUpper;
      const flowLabel = FLOW_LABELS[ft] ?? ft.toUpperCase();
      const stColor = this.statusColor(statusUpper);
      const logo = this.loadLogo();

      const completedRender = order.completed_at
        ? this.fmtDate(order.completed_at)
        : 'Pendiente';

      const stablecoin = this.resolveStablecoin(order);
      const originRows = this.filterNd(this.buildOriginRows(order, clientWallet));
      const destRows = this.filterNd(this.buildDestinationRows(order, supplier, clientWallet));

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
        traceRows.push(this.row('ID Deposito Guira', this.toDisplay(order.deposit_id)));
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

      // ── Client table ──
      const clientTable = {
        table: {
          headerRows: 1,
          widths: ['25%', '25%', '25%', '25%'],
          body: [
            sectionHeader('DATOS DEL CLIENTE', 4),
            [
              { text: 'Nombre / Razón Social', style: 'cellLabel' },
              { text: this.toDisplay(client?.full_name), style: 'cellValue', colSpan: 3 },
              {}, {},
            ],
            [
              { text: 'Correo Electrónico', style: 'cellLabel' },
              { text: this.toDisplay(client?.email), style: 'cellValue' },
              { text: 'Teléfono', style: 'cellLabel' },
              { text: this.toDisplay(client?.phone), style: 'cellValue' },
            ],
          ],
        },
        layout: borderedLayout,
        margin: [0, 0, 0, 14] as [number, number, number, number],
      };

      // ── Origin / Destination side-by-side ──
      const operationTable = {
        table: {
          headerRows: 1,
          widths: ['25%', '25%', '25%', '25%'],
          body: [
            sectionHeader('DETALLES DE LA OPERACIÓN', 4),
            // Sub-headers
            [
              { text: 'ORIGEN', style: 'subHeader', colSpan: 2 }, {},
              { text: 'DESTINO', style: 'subHeader', colSpan: 2 }, {},
            ],
            // Merge origin and destination rows side by side
            ...this.mergeColumns(originRows, destRows),
          ],
        },
        layout: {
          ...borderedLayout,
          // Subtle vertical divider between origin and destination columns
          vLineWidth: (i: number, node: any) => {
            if (i === 0 || i === node.table.widths.length) return 0.6;
            if (i === 2) return 0.4; // center divider
            return 0;
          },
          vLineColor: (i: number) => i === 2 ? COLORS.borderLight : COLORS.border,
        },
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
                    { ...logo, margin: [0, 2, 0, 0] },
                    {
                      stack: [
                        { text: 'COMPROBANTE DE TRANSACCIÓN', style: 'headerTitle' },
                        { text: flowLabel, style: 'headerSubtitle', margin: [0, 3, 0, 0] },
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
                        { text: 'TIPO DE SERVICIO', style: 'amountLabel' },
                        { text: flowLabel, style: 'amountType' },
                      ],
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
          clientTable,
          operationTable,
          traceTable,

          // ═══ ACCENT BOTTOM LINE ═══
          {
            canvas: [{ type: 'rect', x: 0, y: 0, w: 523, h: 2, color: COLORS.accent }],
            margin: [0, 0, 0, 12],
          },

          // ═══ LEGAL DISCLAIMER ═══
          {
            text: [
              { text: 'Aviso Legal: ', bold: true },
              'Transacción ejecutada mediante infraestructura certificada a través de Guira. Registro operativo oficial. No sustituye documentación fiscal ni contable. soporte@guiracorp.com',
            ],
            style: 'disclaimer',
            alignment: 'justify' as const,
          },
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

          // Meta cells
          metaLabel: { fontSize: 7.5, bold: true, color: COLORS.muted, characterSpacing: 0.8, margin: [0, 0, 0, 3] },
          metaId: { fontSize: 7.5, color: COLORS.text, characterSpacing: 0.2 },
          metaValue: { fontSize: 9.5, color: COLORS.text },

          // Amount panel
          amountLabel: { fontSize: 7.5, bold: true, color: COLORS.muted, characterSpacing: 0.8, margin: [0, 0, 0, 4] },
          amountValue: { fontSize: 20, bold: true, color: COLORS.navy },
          amountType: { fontSize: 9, color: COLORS.primary, bold: true, margin: [0, 4, 0, 0] },

          // Section tables
          sectionHeader: { fontSize: 9, bold: true, color: COLORS.white, fillColor: COLORS.navy, characterSpacing: 1 },
          subHeader: { fontSize: 8, bold: true, color: COLORS.primary, characterSpacing: 0.6, margin: [0, 2, 0, 2] },
          cellLabel: { fontSize: 8, color: COLORS.muted },
          cellValue: { fontSize: 9, color: COLORS.text, bold: true },

          // Detail tables (origin, dest, trace)
          tLabel: { fontSize: 8.5, color: COLORS.muted },
          tValue: { fontSize: 9, color: COLORS.text, bold: true },

          // Legal / Footer
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
      headerBg:    '#1C3A3A',
      headerText:  '#FFFFFF',
      headerSub:   '#A8CCCA',
      accent:      '#00968A',
      sectionBg:   '#1A2E2E',
      sectionText: '#FFFFFF',
      summaryBg:   '#D6EEEC',
      summaryLbl:  '#4A7A75',
      body:        '#1A1A1A',
      label:       '#888888',
      border:      '#CCCCCC',
      rowAlt:      '#F5F5F5',
      white:       '#FFFFFF',
    };

    const nd = (val: any) => (val == null || val === '' ? 'N/D' : String(val));
    const emitDate   = this.fmtDate(new Date().toISOString());
    const createdDate = this.fmtDate(order.created_at);
    const completedDate = order.completed_at ? this.fmtDate(order.completed_at) : emitDate;
    const refCode    = nd(order.deposit_reference_code);
    const ctavShort  = `N° CTAV-${ctavId.slice(0, 8).toUpperCase()}`;
    const amountBob  = this.fmtAmount(order.amount);
    const amountDest = this.fmtAmount(order.amount_destination ?? order.net_amount);
    const currency   = (order.currency ?? 'BOB').toUpperCase();
    const destCcy    = (order.destination_currency ?? '').toUpperCase();
    const destNet    = nd(order.destination_network);
    const txRef      = nd(order.tx_hash ?? order.source_tx_hash);
    const walletDest = nd(liquidationAddress?.address);
    const exRate     = nd(order.exchange_rate_applied);

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
      { text: value,  fontSize: 8.5, bold: true, color: C.body, fillColor: alt ? C.rowAlt : C.white },
    ];

    // ── Sección 3: Datos del cliente ──
    const clientRows: any[][] = [secHdr('DATOS DEL CLIENTE', 2)];
    clientRows.push(dr('Nombre / Razón Social', nd(client.full_name)));
    clientRows.push(dr(client.identity_label, nd(client.identity_value), true));
    if (client.nit) clientRows.push(dr('NIT', client.nit));
    clientRows.push(dr('Correo Electrónico', nd(client.email), !!client.nit));
    if (client.phone) clientRows.push(dr('Teléfono', client.phone, !client.nit));

    // ── Sección 4: Detalles (grid 4 columnas) ──
    const detailRows: any[][] = [
      secHdr('DETALLES DE LA OPERACIÓN', 4),
      [
        { text: 'Monto Acreditado',  fontSize: 7.5, color: C.label, fillColor: C.white },
        { text: `${amountDest} ${destCcy}`, fontSize: 8.5, bold: true, color: C.body, fillColor: C.white },
        { text: 'Red / Blockchain',  fontSize: 7.5, color: C.label, fillColor: C.white },
        { text: destNet, fontSize: 8.5, bold: true, color: C.body, fillColor: C.white },
      ],
      [
        { text: 'Wallet Destino', fontSize: 7.5, color: C.label, fillColor: C.rowAlt },
        { text: walletDest, fontSize: 7, bold: true, color: C.body, fillColor: C.rowAlt, colSpan: 3 },
        {}, {},
      ],
      [
        { text: 'Hash / ID Transacción', fontSize: 7.5, color: C.label, fillColor: C.white },
        { text: txRef, fontSize: 7, bold: true, color: C.body, fillColor: C.white, colSpan: 3 },
        {}, {},
      ],
    ];

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
                  { text: 'COMPLETADO', fontSize: 8.5, bold: true, color: C.accent, margin: [0, 3, 0, 0] },
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
                  { text: 'MONTO TRANSFERIDO POR EL CLIENTE', fontSize: 6.5, bold: true, color: C.summaryLbl, characterSpacing: 0.5 },
                  { text: `Bs. ${amountBob}`, fontSize: 20, bold: true, color: C.sectionBg, margin: [0, 3, 0, 0] },
                ],
                fillColor: C.summaryBg,
                border: [true, true, false, true],
                margin: [4, 8, 4, 8],
              },
              {
                stack: [
                  { text: 'TIPO DE CAMBIO APLICADO', fontSize: 6.5, bold: true, color: C.summaryLbl, characterSpacing: 0.5 },
                  { text: exRate, fontSize: 14, bold: true, color: C.sectionBg, margin: [0, 6, 0, 0], decoration: 'underline' as const },
                ],
                fillColor: C.summaryBg,
                border: [false, true, false, true],
                margin: [4, 8, 4, 8],
              },
              {
                stack: [
                  { text: 'ACTIVO VIRTUAL ADQUIRIDO', fontSize: 6.5, bold: true, color: C.summaryLbl, characterSpacing: 0.5 },
                  { text: destCcy || 'N/D', fontSize: 14, bold: true, color: C.sectionBg, margin: [0, 6, 0, 0], decoration: 'underline' as const },
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
        // Párrafo narrativo
        {
          table: {
            widths: ['*'],
            body: [[{
              text: [
                'Se deja constancia de que el PSAV ',
                { text: psavAgent.name, bold: true },
                ' realizó la compra de ',
                { text: destCcy, bold: true },
                ' en favor de ',
                { text: nd(client.full_name), bold: true },
                ', por la suma transferida de ',
                { text: `Bs. ${amountBob}`, bold: true },
                ', aplicando el tipo de cambio vigente/referencial de ',
                { text: exRate, bold: true },
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
}
