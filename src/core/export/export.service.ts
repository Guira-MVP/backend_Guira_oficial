import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
const pdfmake = require('pdfmake');
import * as fs from 'fs';
import * as path from 'path';
import { formatBoliviaDateTime } from '../../common/utils/date.util';

// ── Tipos internos ──────────────────────────────────────────────────────────

interface ClientProfile {
  id: string;
  full_name: string | null;
  email: string;
  phone?: string | null;
}

interface Supplier {
  id: string;
  name: string;
}

interface PaymentOrder {
  id: string;
  created_at: string;
  status: string;
  flow_type?: string;
  supplier_id?: string | null;
  source_currency?: string;
  currency?: string;
  amount?: number;
  destination_currency?: string;
  amount_destination?: number;
  net_amount?: number;
  fee_amount?: number;
  exchange_rate_applied?: number;
  [key: string]: unknown;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(isoStr: string): string {
  // Hora de Bolivia (UTC-4). El valor se guarda en UTC; aquí solo se presenta.
  return formatBoliviaDateTime(isoStr, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

const STATUS_LABELS: Record<string, string> = {
  created: 'Orden creada',
  waiting_deposit: 'Esperando depósito',
  deposit_received: 'Depósito validado',
  processing: 'Procesando',
  sent: 'Enviado',
  completed: 'Completado',
  cancelled: 'Cancelado',
  failed: 'Fallido',
  swept_external: 'Swept external',
};

const FLOW_LABELS: Record<string, string> = {
  bolivia_to_world: 'Bolivia al exterior',
  bolivia_to_wallet: 'Bolivia a cripto',
  world_to_bolivia: 'Exterior a Bolivia',
  world_to_wallet: 'Exterior a cripto',
  wallet_to_wallet: 'Cripto a cripto',
  wallet_to_fiat: 'Cripto a banco',
  fiat_bo_to_bridge_wallet: 'Bolivia a Guira',
  fiat_us_to_bridge_wallet: 'Exterior a Guira',
  crypto_to_bridge_wallet: 'Cripto a Guira',
  bridge_wallet_to_fiat_bo: 'Guira a Bolivia',
  bridge_wallet_to_crypto: 'Guira a cripto',
  bridge_wallet_to_fiat_us: 'Guira al exterior',
  va_deposit: 'Depósito cuenta virtual',
};

function buildRows(orders: PaymentOrder[], suppliersMap: Map<string, string>, noSupplierFallback?: string) {
  const fallback = noSupplierFallback || 'Sin proveedor';
  return orders.map((o) => ({
    id: o.id.slice(0, 8).toUpperCase(),
    fecha: formatDate(o.created_at),
    flujo: FLOW_LABELS[o.flow_type ?? ''] ?? o.flow_type ?? 'N/D',
    estado: STATUS_LABELS[o.status] ?? o.status,
    proveedor: o.supplier_id ? (suppliersMap.get(o.supplier_id) ?? 'N/D') : fallback,
    moneda_origen: (o.source_currency ?? o.currency ?? '').toUpperCase(),
    monto_origen: o.amount ?? 0,
    moneda_destino: (o.destination_currency ?? '').toUpperCase(),
    monto_destino: o.amount_destination ?? o.net_amount ?? 0,
    fee: o.fee_amount ?? 0,
    tipo_cambio: o.exchange_rate_applied ?? 1,
  }));
}

// ── Servicio ──────────────────────────────────────────────────────────────────

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);
  private printer: any;

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

  // ── EXCEL ──────────────────────────────────────────────────────────────────

  async generateExcel(
    orders: PaymentOrder[],
    suppliers: Supplier[],
    client: ClientProfile,
    filters: { status?: string },
  ): Promise<Buffer> {
    const suppliersMap = new Map(suppliers.map((s) => [s.id, s.name]));
    const rows = buildRows(orders, suppliersMap, client.full_name ?? undefined);
    const generatedAt = formatBoliviaDateTime(new Date(), { hour12: false });
    const filterLabel = filters.status
      ? (STATUS_LABELS[filters.status] ?? filters.status)
      : 'Todos los estados';

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Guira';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Expedientes', {
      pageSetup: { orientation: 'landscape', fitToPage: true },
    });

    // ── Paleta "Oceanic Trust" — alineada al frontend ──
    // Logo gradient: #00D8FF → #0051FF  |  Primary: #0B5FE6  |  Foreground: #0D1B3E
    const BRAND_PRIMARY  = '0B5FE6'; // Primary blue (punto medio del gradiente logo)
    const BRAND_NAVY     = '0D1B3E'; // Navy profundo — foreground principal
    const BRAND_ROYAL    = '0150F2'; // Azul royal sólido del logo
    const BRAND_TEAL     = '1A9AB7'; // Accent teal sofisticado
    const BRAND_CYAN     = '01C5FF'; // Cyan claro del gradiente logo
    const HEADER_BG      = '0B3D91'; // Navy header — derivado oscuro del primary
    const HEADER_FG      = 'FFFFFF';
    const ROW_EVEN_BG    = 'EDF4FE'; // Blue-50 wash — sutil como el background del frontend
    const SECTION_BG     = 'DBEAFE'; // Blue-100 — para totales y secciones destacadas
    const META_FG        = '4B6A9B'; // Slate azulado — muted foreground
    const BORDER_BLUE    = 'B8D4F0'; // Borde suave azul (var --border del frontend)
    const TITLE_BAND_BG  = 'F0F7FF'; // Fondo del bloque de cabecera

    // ── Logo (PNG — lectura directa) ──
    let logoImageId: number | null = null;
    try {
      const logoPath = path.join(process.cwd(), 'assets', 'LOGO GUIRRA 02.png');
      if (fs.existsSync(logoPath)) {
        const pngBuffer = fs.readFileSync(logoPath);
        logoImageId = workbook.addImage({
          buffer: pngBuffer as any,
          extension: 'png',
        });
      }
    } catch (err) {
      this.logger.warn('No se pudo cargar LOGO GUIRRA 02.png para el reporte Excel', err);
    }

    // ── BLOQUE DE CABECERA DEL REPORTE ──

    // Fondo de la cabecera (filas 1-4)
    for (let r = 1; r <= 4; r++) {
      const row = sheet.getRow(r);
      for (let c = 1; c <= 12; c++) {
        const cell = row.getCell(c);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TITLE_BAND_BG } };
      }
    }

    // Logo izquierda: ocupa cols A-C (0-2) y filas 1-3 (0-2), centrado con padding interno
    sheet.getRow(1).height = 28;
    sheet.getRow(2).height = 22;
    sheet.getRow(3).height = 20;
    if (logoImageId !== null) {
      sheet.addImage(logoImageId, {
        tl: { col: 0.2, row: 0.2 } as any,
        ext: { width: 140, height: 52 },
        editAs: 'absolute',
      });
    }

    // Título del reporte — cols D-L, fila 1
    sheet.mergeCells('D1:L1');
    const titleCell = sheet.getCell('D1');
    titleCell.value = 'GUIRA — Reporte de Expedientes';
    titleCell.font = { bold: true, size: 14, color: { argb: BRAND_NAVY } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'left' };

    // Datos del cliente — cols D-L, fila 2
    sheet.mergeCells('D2:L2');
    const clientCell = sheet.getCell('D2');
    clientCell.value = `Cliente: ${client.full_name ?? 'N/D'}   |   Email: ${client.email}   |   Teléfono: ${client.phone ?? 'N/D'}`;
    clientCell.font = { size: 10, color: { argb: META_FG } };
    clientCell.alignment = { vertical: 'middle', horizontal: 'left' };

    // Filtros y fecha — cols D-L, fila 3
    sheet.mergeCells('D3:L3');
    const filterCell = sheet.getCell('D3');
    filterCell.value = `Filtro: ${filterLabel}   |   Generado: ${generatedAt}   |   Total: ${orders.length} expedientes`;
    filterCell.font = { size: 9, color: { argb: META_FG }, italic: true };
    filterCell.alignment = { vertical: 'middle', horizontal: 'left' };

    // Línea decorativa de separación (fila 4)
    sheet.getRow(4).height = 4;
    for (let c = 1; c <= 12; c++) {
      sheet.getRow(4).getCell(c).border = {
        bottom: { style: 'medium', color: { argb: BRAND_PRIMARY } },
      };
    }

    // Fila vacía separadora
    sheet.getRow(5).height = 10;

    // ── Fila de encabezados de tabla (fila 6) ──
    const HEADERS = [
      { key: '_margin',       label: '',                  width: 3  },
      { key: 'id',            label: 'ID',                width: 12 },
      { key: 'fecha',         label: 'Fecha',             width: 20 },
      { key: 'flujo',         label: 'Flujo',             width: 26 },
      { key: 'estado',        label: 'Estado',            width: 20 },
      { key: 'proveedor',     label: 'Proveedor',         width: 22 },
      { key: 'moneda_origen', label: 'Moneda Origen',     width: 15 },
      { key: 'monto_origen',  label: 'Monto Origen',      width: 16 },
      { key: 'moneda_destino',label: 'Moneda Destino',    width: 15 },
      { key: 'monto_destino', label: 'Monto Destino',     width: 16 },
      { key: 'fee',           label: 'Comisión',          width: 14 },
      { key: 'tipo_cambio',   label: 'Tipo de Cambio',    width: 16 },
    ];

    const DATA_START_ROW = 6;
    const headerRow = sheet.getRow(DATA_START_ROW);
    HEADERS.forEach((h, idx) => {
      const col = idx + 1;
      sheet.getColumn(col).width = h.width;
      const cell = headerRow.getCell(col);
      cell.value = h.label;
      cell.font = { bold: true, color: { argb: HEADER_FG }, size: 10 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
      cell.border = {
        bottom: { style: 'thin', color: { argb: BRAND_CYAN } },
      };
    });
    headerRow.height = 26;

    // ── Filas de datos ──
    rows.forEach((row, rowIdx) => {
      const excelRow = sheet.getRow(DATA_START_ROW + 1 + rowIdx);
      const isEven = rowIdx % 2 === 1;
      const values = [
        '',              // margen izquierdo
        row.id,
        row.fecha,
        row.flujo,
        row.estado,
        row.proveedor,
        row.moneda_origen,
        row.monto_origen,
        row.moneda_destino,
        row.monto_destino,
        row.fee,
        row.tipo_cambio,
      ];

      values.forEach((val, colIdx) => {
        const cell = excelRow.getCell(colIdx + 1);
        cell.value = val;
        cell.font = { size: 9, color: { argb: BRAND_NAVY } };
        cell.alignment = { vertical: 'middle', horizontal: colIdx === 1 ? 'center' : 'left' };
        if (isEven) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ROW_EVEN_BG } };
        }
        // Bordes laterales sutiles
        cell.border = {
          bottom: { style: 'hair', color: { argb: BORDER_BLUE } },
        };
        // Formato numérico para montos y fee
        if ([7, 9, 10, 11].includes(colIdx)) {
          cell.numFmt = '#,##0.00';
          cell.alignment = { horizontal: 'right', vertical: 'middle' };
        }
      });
      excelRow.height = 19;
    });

    // ── Fila de cierre (solo conteo de registros) ──
    const totalsRowIdx = DATA_START_ROW + 1 + rows.length;
    const totalsRow = sheet.getRow(totalsRowIdx);
    sheet.mergeCells(`A${totalsRowIdx}:L${totalsRowIdx}`);
    totalsRow.getCell(1).value = `Total de registros: ${rows.length}`;
    totalsRow.getCell(1).font = { bold: true, size: 9, color: { argb: BRAND_NAVY } };
    totalsRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SECTION_BG } };
    totalsRow.getCell(1).alignment = { horizontal: 'right', vertical: 'middle' };
    totalsRow.getCell(1).border = { top: { style: 'medium', color: { argb: BRAND_PRIMARY } } };
    totalsRow.height = 22;

    // ── Pie de página ──
    sheet.headerFooter.oddFooter = `&LGuira - Operaciones Financieras Seguras&RGenerado: ${generatedAt}`;

    return workbook.xlsx.writeBuffer() as unknown as Buffer;
  }

  // ── PDF ────────────────────────────────────────────────────────────────────

  async generatePdfReport(
    orders: PaymentOrder[],
    suppliers: Supplier[],
    client: ClientProfile,
    filters: { status?: string },
  ): Promise<Buffer> {
    const suppliersMap = new Map(suppliers.map((s) => [s.id, s.name]));
    const rows = buildRows(orders, suppliersMap, client.full_name ?? undefined);
    const generatedAt = formatBoliviaDateTime(new Date(), { hour12: false });
    const filterLabel = filters.status
      ? (STATUS_LABELS[filters.status] ?? filters.status)
      : 'Todos los estados';

    const PRIMARY   = '#1e293b';
    const ACCENT    = '#3b82f6';
    const HEADER_BG = '#1e40af';
    const EVEN_BG   = '#f1f5f9';

    // Logo PNG (LOGO GUIRRA 02)
    let logoBlock: any = { text: 'Guira', style: 'brandName', alignment: 'center' };
    try {
      const logoPath = path.join(process.cwd(), 'assets', 'LOGO GUIRRA 02.png');
      if (fs.existsSync(logoPath)) {
        const pngBuffer = fs.readFileSync(logoPath);
        const base64 = `data:image/png;base64,${pngBuffer.toString('base64')}`;
        logoBlock = { image: base64, width: 160, alignment: 'center', margin: [0, 0, 0, 6] };
      }
    } catch {
      this.logger.warn('No se pudo cargar LOGO GUIRRA 02.png para el PDF de reporte');
    }

    const tableBody: any[][] = [
      // Cabecera de tabla
      [
        { text: 'ID',              style: 'th', fillColor: HEADER_BG },
        { text: 'Fecha',           style: 'th', fillColor: HEADER_BG },
        { text: 'Flujo',           style: 'th', fillColor: HEADER_BG },
        { text: 'Estado',          style: 'th', fillColor: HEADER_BG },
        { text: 'Proveedor',       style: 'th', fillColor: HEADER_BG },
        { text: 'Mon. Origen',     style: 'th', fillColor: HEADER_BG },
        { text: 'Monto Origen',    style: 'th', fillColor: HEADER_BG },
        { text: 'Mon. Destino',    style: 'th', fillColor: HEADER_BG },
        { text: 'Monto Destino',   style: 'th', fillColor: HEADER_BG },
        { text: 'Comisión',       style: 'th', fillColor: HEADER_BG },
        { text: 'Tipo Cambio',     style: 'th', fillColor: HEADER_BG },
      ],
    ];

    rows.forEach((r, idx) => {
      const bg = idx % 2 === 1 ? EVEN_BG : null;
      const cell = (val: string | number, align = 'left') => ({
        text: String(val),
        style: 'td',
        alignment: align,
        ...(bg ? { fillColor: bg } : {}),
      });
      tableBody.push([
        cell(r.id, 'center'),
        cell(r.fecha),
        cell(r.flujo),
        cell(r.estado),
        cell(r.proveedor),
        cell(r.moneda_origen, 'center'),
        cell(r.monto_origen.toFixed(2), 'right'),
        cell(r.moneda_destino, 'center'),
        cell(r.monto_destino.toFixed(2), 'right'),
        cell(r.fee.toFixed(2), 'right'),
        cell(r.tipo_cambio?.toString() ?? '1', 'right'),
      ]);
    });

    const docDef: any = {
      pageSize: 'A4',
      pageOrientation: 'landscape',
      pageMargins: [30, 50, 30, 50],
      defaultStyle: { font: 'Helvetica', fontSize: 7, color: '#334155' },
      content: [
        // Encabezado
        {
          stack: [
            logoBlock,
            { text: 'REPORTE DE EXPEDIENTES', style: 'reportTitle', alignment: 'center' },
            { text: `Generado: ${generatedAt}`, style: 'meta', alignment: 'center' },
            { text: `Filtro: ${filterLabel}`, style: 'meta', alignment: 'center' },
          ],
          margin: [0, 0, 0, 12],
        },
        // Datos del cliente
        {
          table: {
            widths: ['*'],
            body: [[{
              columns: [
                { text: [{ text: 'Cliente: ', bold: true }, client.full_name ?? 'N/D'], width: '*' },
                { text: [{ text: 'Email: ',   bold: true }, client.email],              width: '*' },
                { text: [{ text: 'Teléfono: ',bold: true }, client.phone ?? 'N/D'],     width: '*' },
                { text: [{ text: 'Expedientes: ', bold: true }, String(orders.length)], width: 'auto' },
              ],
              fillColor: '#eff6ff',
              margin: [8, 6, 8, 6],
            }]],
          },
          layout: 'noBorders',
          margin: [0, 0, 0, 14],
        },
        // Tabla de expedientes
        {
          table: {
            headerRows: 1,
            widths: [36, 52, 60, 52, 52, 28, 40, 32, 40, 32, 36],
            body: tableBody,
          },
          layout: {
            hLineWidth: (i: number) => (i === 0 || i === 1 ? 0 : 0.5),
            vLineWidth: () => 0,
            hLineColor: () => '#e2e8f0',
            paddingTop: () => 4,
            paddingBottom: () => 4,
            paddingLeft: () => 4,
            paddingRight: () => 4,
          },
        },
        // Cierre — solo conteo de registros
        {
          margin: [0, 10, 0, 0],
          text: `Total de registros: ${rows.length}`,
          style: 'totalLabel',
          alignment: 'right',
        },
      ],
      footer: (currentPage: number, pageCount: number) => ({
        columns: [
          { text: 'Guira - Operaciones Financieras Seguras', style: 'footer', alignment: 'left' },
          { text: `Página ${currentPage} de ${pageCount}`, style: 'footer', alignment: 'right' },
        ],
        margin: [30, 8, 30, 0],
      }),
      styles: {
        brandName:   { fontSize: 18, bold: true, color: PRIMARY },
        reportTitle: { fontSize: 13, bold: true, color: PRIMARY },
        meta:        { fontSize: 8, color: '#64748b' },
        th: {
          fontSize: 7,
          bold: true,
          color: '#ffffff',
          alignment: 'center',
          margin: [2, 2, 2, 2],
        },
        td:          { fontSize: 7, color: '#1e293b', margin: [2, 2, 2, 2] },
        totalLabel:  { fontSize: 8, bold: true, color: PRIMARY, margin: [0, 2, 12, 2] },
        totalValue:  { fontSize: 8, bold: true, color: ACCENT, alignment: 'right', margin: [0, 2, 0, 2] },
        footer:      { fontSize: 7, color: '#94a3b8' },
      },
    };

    const pdf = this.printer.createPdf(docDef);
    return pdf.getBuffer();
  }
}
