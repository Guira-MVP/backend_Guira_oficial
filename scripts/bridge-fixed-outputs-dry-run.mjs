#!/usr/bin/env node
/**
 * Valida contra Bridge (dry_run: true — no crea nada) que la forma del Transfer
 * de bolivia_to_world sea aceptada: origen solana/usdc sin from_address +
 * allow_any_from_address, destination.amount (Fixed Outputs) y developer_fee.
 *
 * Lee BRIDGE_API_KEY y BRIDGE_API_URL de .env.local. Nunca imprime la key.
 *
 * Uso:
 *   node scripts/bridge-fixed-outputs-dry-run.mjs <bridge_customer_id> <rail:currency:external_account_id> [...]
 * Ej.:
 *   node scripts/bridge-fixed-outputs-dry-run.mjs cus_123 sepa:eur:ea_1 spei:mxn:ea_2 ach:usd:ea_3 wire:usd:ea_3
 */
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')];
    }),
);

const apiKey = env.BRIDGE_API_KEY;
const baseUrl = (env.BRIDGE_API_URL ?? '').replace(/\/v0\/?$/, '');
if (!apiKey || !baseUrl) {
  console.error('Faltan BRIDGE_API_KEY / BRIDGE_API_URL en .env.local');
  process.exit(1);
}
if (apiKey.startsWith('sk-live')) {
  console.error('La key de .env.local es de PRODUCCIÓN (sk-live). Usa la de sandbox.');
  process.exit(1);
}

const [customerId, ...cases] = process.argv.slice(2);
if (!customerId || cases.length === 0) {
  console.error('Uso: node scripts/bridge-fixed-outputs-dry-run.mjs <customer_id> <rail:currency:ea_id> [...]');
  process.exit(1);
}

const REF_FIELD = {
  sepa: 'sepa_reference',
  wire: 'wire_message',
  ach: 'ach_reference',
  spei: 'spei_reference',
  pix: 'reference',
  faster_payments: 'reference',
};

console.log(`Bridge: ${baseUrl} (sandbox)\n`);
for (const c of cases) {
  const [rail, currency, externalAccountId] = c.split(':');
  const body = {
    on_behalf_of: customerId,
    source: { payment_rail: 'solana', currency: 'usdc' },
    destination: {
      payment_rail: rail,
      currency,
      external_account_id: externalAccountId,
      amount: '100.00',
      ...(REF_FIELD[rail] ? { [REF_FIELD[rail]]: rail === 'ach' ? 'GUIRA' : 'Guira DRYRUN01' } : {}),
    },
    developer_fee: '5.00',
    client_reference_id: `dryrun-${rail}-${currency}`,
    features: { allow_any_from_address: true },
    dry_run: true,
  };

  const res = await fetch(`${baseUrl}/v0/transfers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': apiKey,
      'Idempotency-Key': `dryrun-${rail}-${currency}-${Date.now()}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`── ${rail}/${currency} → HTTP ${res.status}`);
  console.log(text.slice(0, 1500), '\n');
}
