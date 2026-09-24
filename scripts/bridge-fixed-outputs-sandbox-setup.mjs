#!/usr/bin/env node
/**
 * Prepara el SANDBOX de Bridge para bridge-fixed-outputs-dryrun.mjs:
 *   1. Simula un depósito de 500 USDC en la bridge wallet del customer.
 *   2. Crea una cuenta externa EUR (IBAN de ejemplo de la doc de Bridge).
 *   3. Intenta crear una cuenta externa MXN (CLABE de ejemplo); puede fallar
 *      si el customer no tiene endorsement SPEI.
 *
 * Solo sandbox: aborta si BRIDGE_API_URL no contiene "sandbox".
 * Uso: node scripts/bridge-fixed-outputs-sandbox-setup.mjs --customer <id> --wallet <id>
 */
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

if (existsSync('.env.local')) {
  for (const l of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
const BASE = (process.env.BRIDGE_API_URL ?? '').replace(/\/v0\/?$/, '');
if (!BASE.includes('sandbox')) {
  console.error(`✋ BRIDGE_API_URL no es sandbox (${BASE || 'vacío'}). Abortado.`);
  process.exit(1);
}
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const cid = args.customer ?? '962fad34-3bfc-4f2f-86ab-870e2110ba81';
const wid = args.wallet ?? '7912c8c9-e822-438d-a6f2-78a869bd7eae';

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Api-Key': process.env.BRIDGE_API_KEY ?? '',
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, id: j?.id, message: j?.message, key: j?.source?.key };
}

const owner = {
  account_owner_name: 'Guira DryRun',
  account_owner_type: 'individual',
  first_name: 'Guira',
  last_name: 'DryRun',
};

console.log('Depósito simulado 500 USDC:',
  await post(`/v0/customers/${cid}/wallets/${wid}/simulate_deposit`, { amount: '500.0', currency: 'usdc' }));
console.log('Depósito simulado 500 USDT:',
  await post(`/v0/customers/${cid}/wallets/${wid}/simulate_deposit`, { amount: '500.0', currency: 'usdt' }));
console.log('Cuenta EUR:', await post(`/v0/customers/${cid}/external_accounts`, {
  ...owner,
  currency: 'eur',
  bank_name: 'ABN AMRO',
  account_type: 'iban',
  iban: { account_number: 'NL91ABNA0417164300', bic: 'ABNANL2A', country: 'NLD' },
  address: { street_line_1: 'Dam 1', city: 'Amsterdam', postal_code: '1012 JS', country: 'NLD' },
}));
console.log('Cuenta MXN:', await post(`/v0/customers/${cid}/external_accounts`, {
  ...owner,
  currency: 'mxn',
  bank_name: 'Banco Santander México',
  account_type: 'clabe',
  clabe: { account_number: '014180655500000007' },
  address: { street_line_1: 'Av Reforma 1', city: 'Ciudad de Mexico', postal_code: '06600', country: 'MEX' },
}));
