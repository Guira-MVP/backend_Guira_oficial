
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'pdf.service.ts');
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
  'async generatePaymentPdf(order: any, supplier: any | null): Promise<Buffer> {',
  'async generatePaymentPdf(order: any, supplier: any | null, client?: any, clientWallet?: any): Promise<Buffer> {'
);

code = code.replace(
  'if (statusUpper === \'FAILED\' || statusUpper === \'REJECTED\')',
  'if (statusUpper === \'FAILED\' || statusUpper === \'REJECTED\' || statusUpper === \'CANCELLED\')'
);

let stablecoinBlock = 
      let stablecoin = readString(metadata, 'stablecoin');
      if (!stablecoin) {
        if (
          [
            'crypto_to_bridge_wallet',
            'bridge_wallet_to_crypto',
            'wallet_to_wallet',
            'bolivia_to_wallet',
          ].includes(order.flow_type)
        ) {
          stablecoin = order.destination_currency ?? order.currency ?? 'N/D';
        } else {
          stablecoin = 'N/D';
        }
      }
;

code = code.replace(
  'const completedRender = order.completed_at\n        ? formatDateTime(order.completed_at)\n        : completedAtFallback\n          ? formatDateTime(completedAtFallback)\n          : \'Pendiente\';',
  'const completedRender = order.completed_at\n        ? formatDateTime(order.completed_at)\n        : completedAtFallback\n          ? formatDateTime(completedAtFallback)\n          : \'Pendiente\';\n' + stablecoinBlock
);

code = code.replace(
  'text: toDisplayValue(readString(metadata, \\'stablecoin\\')),',
  'text: toDisplayValue(stablecoin),'
);

let originDestinationCols =           {
            text: 'Datos del Cliente',
            style: 'sectionTitle',
            margin: [0, 15, 0, 10],
          },
          {
            canvas: [
              {
                type: 'line',
                x1: 0,
                y1: 0,
                x2: 515,
                y2: 0,
                lineWidth: 1,
                lineColor: '#e2e8f0',
              },
            ],
            margin: [0, 0, 0, 15],
          },
          {
            columns: [
              {
                width: '50%',
                stack: [
                  { text: 'Nombre / Razón Social:', style: 'label' },
                  { text: toDisplayValue(client?.full_name), style: 'value' },
                ],
              },
              {
                width: '50%',
                stack: [
                  { text: 'Correo Electrónico:', style: 'label' },
                  { text: toDisplayValue(client?.email), style: 'value' },
                  { text: 'Teléfono:', style: 'label' },
                  { text: toDisplayValue(client?.phone), style: 'value' },
                ],
              },
            ],
            columnGap: 20,
            margin: [0, 0, 0, 20],
          },
          {
            text: 'Detalles de la Operación',
            style: 'sectionTitle',
            margin: [0, 15, 0, 10],
          },
          {
            canvas: [
              {
                type: 'line',
                x1: 0,
                y1: 0,
                x2: 515,
                y2: 0,
                lineWidth: 1,
                lineColor: '#e2e8f0',
              },
            ],
            margin: [0, 0, 0, 15],
          },
          // INFORMATION COLUMNS
          {
            columns: [
              // Columna Izquierda (Origen)
              {
                width: '50%',
                stack: (function() {
                  let originDetails = [
                    { text: 'DATOS DE ORIGEN', style: 'groupTitle' },
                    { text: 'Monto Original:', style: 'label' },
                    { text: \\ \\, style: 'value' },
                    { text: 'Tarifa (Fee):', style: 'label' },
                    { text: \\ \\, style: 'value' },
                    { text: 'Tipo de Cambio Aplicado:', style: 'label' },
                    { text: toDisplayValue(order.exchange_rate_applied), style: 'value' },
                    { text: 'Tipo de Operación:', style: 'label' },
                    { text: orderType.toUpperCase(), style: 'value' }
                  ];

                  if (['bridge_wallet_to_fiat_bo', 'bridge_wallet_to_fiat_us', 'bridge_wallet_to_crypto', 'wallet_to_fiat'].includes(order.flow_type)) {
                    originDetails.push(
                      { text: 'Billetera de Origen:', style: 'label' },
                      { text: toDisplayValue(clientWallet?.address), style: 'value' },
                      { text: 'Red de Origen:', style: 'label' },
                      { text: toDisplayValue(clientWallet?.network), style: 'value' }
                    );
                  }
                  return originDetails;
                })()
              },
              // Columna Derecha
              {
                width: '50%',
                stack: (function() {
                  let destinationDetails = [
                    { text: 'DATOS DE DESTINO', style: 'groupTitle' },
                    { text: 'Propósito:', style: 'label' },
                    { text: toDisplayValue(order.business_purpose ?? readString(metadata, 'payment_reason')), style: 'value' }
                  ];

                  const deliveryMethod = readString(metadata, 'delivery_method');
                  if (deliveryMethod) {
                    destinationDetails.push(
                      { text: 'Método de Entrega:', style: 'label' },
                      { text: toDisplayValue(deliveryMethod), style: 'value' }
                    );
                  }

                  if (['bolivia_to_world'].includes(order.flow_type)) {
                    destinationDetails.push(
                      { text: 'Proveedor Asignado:', style: 'label' },
                      { text: toDisplayValue(supplier?.name ?? 'No asignado'), style: 'value' }
                    );
                    const extAccount = supplier?.external_accounts?.find((acc) => acc.id === order.external_account_id);
                    if (extAccount) {
                      destinationDetails.push(
                         { text: 'Banco Destino:', style: 'label' },
                         { text: toDisplayValue(extAccount.bank_name), style: 'value' },
                         { text: 'Cuenta Destino:', style: 'label' },
                         { text: toDisplayValue(extAccount.account_number), style: 'value' }
                      );
                    } else {
                      destinationDetails.push(
                         { text: 'Dirección Destino / Cuenta:', style: 'label' },
                         { text: toDisplayValue(order.destination_address ?? readString(metadata, 'destination_address')), style: 'value' }
                      );
                    }
                  } else if (['bolivia_to_wallet', 'wallet_to_wallet'].includes(order.flow_type)) {
                    destinationDetails.push(
                      { text: 'Proveedor Asignado:', style: 'label' },
                      { text: toDisplayValue(supplier?.name ?? 'No asignado'), style: 'value' },
                      { text: 'Dirección de Destino:', style: 'label' },
                      { text: toDisplayValue(supplier?.bank_details?.wallet_address ?? order.destination_address), style: 'value' },
                      { text: 'Red de Destino:', style: 'label' },
                      { text: toDisplayValue(supplier?.bank_details?.wallet_network), style: 'value' }
                    );
                  } else if (['fiat_bo_to_bridge_wallet', 'fiat_us_to_bridge_wallet', 'crypto_to_bridge_wallet'].includes(order.flow_type)) {
                    destinationDetails.push(
                      { text: 'Billetera de Destino:', style: 'label' },
                      { text: toDisplayValue(clientWallet?.address), style: 'value' },
                      { text: 'Red de Destino:', style: 'label' },
                      { text: toDisplayValue(clientWallet?.network), style: 'value' }
                    );
                  } else {
                    destinationDetails.push(
                      { text: 'Dirección Destino / Cuenta:', style: 'label' },
                      { text: toDisplayValue(order.destination_address ?? readString(metadata, 'destination_address')), style: 'value' }
                    );
                  }
                  return destinationDetails;
                })()
              },
            ],
            columnGap: 20,
            margin: [0, 0, 0, 20],
          },;

let colStart = code.indexOf('{ text: \\'Detalles de la Operación\\',');
let colEnd = code.indexOf('{ text: \\'Trazabilidad y Referencias\\',');
if (colStart > -1 && colEnd > -1) {
  let toReplace = code.substring(colStart - 12, colEnd - 12);
  code = code.replace(toReplace, originDestinationCols + '\n\n          ');
}

fs.writeFileSync(file, code);
console.log('done');

