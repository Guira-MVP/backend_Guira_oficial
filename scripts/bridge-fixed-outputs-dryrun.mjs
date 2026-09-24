#!/usr/bin/env node
/**
 * Verifica en SANDBOX si Bridge acepta Fixed Outputs (source.amount +
 * destination.amount) para payouts desde una bridge_wallet.
 *
 * Todas las llamadas POST van con dry_run: true: no se crea ningún transfer ni
 * se mueve saldo. Aborta si BRIDGE_API_URL no es de sandbox.
 *
 * Uso (desde backend_Guira_oficial):
 *   node scripts/bridge-fixed-outputs-dryrun.mjs
 *   node scripts/bridge-fixed-outputs-dryrun.mjs --customer <id> --wallet <id>
 *
 * Sin argumentos busca por su cuenta un customer con bridge wallet y cuentas
 * externas en divisa no-USD. Lee BRIDGE_API_URL y BRIDGE_API_KEY de .env.local
 * (o del entorno). La key nunca se imprime.
 */
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// ── Config ────────────────────────────────────────────────────────────────
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnvFile('.env.local');

const BASE = (process.env.BRIDGE_API_URL ?? '').replace(/\/v0\/?$/, '');
const KEY = process.env.BRIDGE_API_KEY ?? '';
if (!BASE.includes('sandbox')) {
  console.error(`✋ BRIDGE_API_URL no es sandbox (${BASE || 'vacío'}). Abortado.`);
  process.exit(1);
}
if (!KEY) {
  console.error('✋ Falta BRIDGE_API_KEY.');
  process.exit(1);
}

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);

// Riel por divisa, igual que FIAT_US_FIXED_RAIL_BY_CURRENCY del frontend.
const RAIL_BY_CURRENCY = {
  eur: 'sepa',
  mxn: 'spei',
  brl: 'pix',
  gbp: 'faster_payments',
  cop: 'bre_b',
};
const DEST_AMOUNT = 100; // en divisa destino
const DEV_FEE = 1; // USD

// ── HTTP ──────────────────────────────────────────────────────────────────
async function bridge(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': KEY,
      ...(method === 'POST' ? { 'Idempotency-Key': `dryrun_${randomUUID()}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
  return { status: res.status, json };
}

const list = (j) => (Array.isArray(j) ? j : j?.data ?? []);

// ── Descubrimiento ───────────────────────────────────────────────────────
async function discover() {
  if (args.customer && args.wallet) {
    const ea = await bridge('GET', `/v0/customers/${args.customer}/external_accounts?limit=100`);
    return { customerId: args.customer, walletId: args.wallet, accounts: list(ea.json) };
  }
  const customers = await bridge('GET', '/v0/customers?limit=100');
  for (const c of list(customers.json)) {
    const wallets = list((await bridge('GET', `/v0/customers/${c.id}/wallets`)).json);
    if (!wallets.length) continue;
    const accounts = list(
      (await bridge('GET', `/v0/customers/${c.id}/external_accounts?limit=100`)).json,
    ).filter((a) => a.active !== false && (a.currency ?? 'usd').toLowerCase() !== 'usd');
    if (accounts.length) return { customerId: c.id, walletId: wallets[0].id, accounts };
  }
  return null;
}

// ── Casos ────────────────────────────────────────────────────────────────
function baseBody(customerId, walletId, sourceCurrency, account, rail) {
  return {
    dry_run: true,
    on_behalf_of: customerId,
    client_reference_id: `dryrun_${randomUUID()}`,
    source: {
      payment_rail: 'bridge_wallet',
      currency: sourceCurrency,
      bridge_wallet_id: walletId,
    },
    destination: {
      payment_rail: rail,
      currency: account.currency.toLowerCase(),
      external_account_id: account.id,
      ...(rail === 'sepa' ? { sepa_reference: 'Guira DRYRUN01' } : {}),
      ...(rail === 'spei' ? { spei_reference: 'Guira DRYRUN01' } : {}),
      ...(rail === 'pix' || rail === 'faster_payments' ? { reference: 'DRYRUN01' } : {}),
    },
  };
}

function summarize(r) {
  const j = r.json ?? {};
  const msg = j.message ?? j.error ?? '';
  const key = j.source?.key ? JSON.stringify(j.source.key) : '';
  return r.status < 300
    ? `✅ ${r.status} ${JSON.stringify({
        amount: j.amount,
        source_amount: j.source?.amount,
        destination_amount: j.destination?.amount,
        exchange_rate_spread: j.destination?.exchange_rate_spread,
        receipt: j.receipt,
        state: j.state,
      })}`
    : `❌ ${r.status} ${j.code ?? ''} ${msg} ${key}`.trim();
}

async function main() {
  console.log(`Sandbox: ${BASE}\n`);
  const found = await discover();
  if (!found) {
    console.error('No se encontró customer con bridge wallet + cuenta externa no-USD. Usa --customer y --wallet.');
    process.exit(1);
  }
  const { customerId, walletId, accounts } = found;
  console.log(`customer=${customerId} wallet=${walletId}`);
  console.log(`cuentas no-USD: ${accounts.map((a) => `${a.currency}/${a.account_type}`).join(', ')}\n`);

  const seen = new Set();
  for (const account of accounts) {
    const cur = account.currency.toLowerCase();
    if (seen.has(cur)) continue;
    seen.add(cur);
    const rail = RAIL_BY_CURRENCY[cur];
    if (!rail) { console.log(`— ${cur}: sin riel mapeado, se omite`); continue; }

    const fx = (await bridge('GET', `/v0/exchange_rates?from=usd&to=${cur}`)).json;
    const sell = parseFloat(fx?.sell_rate);
    console.log(`══ ${cur.toUpperCase()} (${rail}) · sell_rate=${fx?.sell_rate} mid=${fx?.midmarket_rate}`);
    if (!sell) { console.log('   sin tasa, se omite\n'); continue; }

    const minUsd = DEST_AMOUNT / sell + DEV_FEE;
    const ok = (minUsd * 1.03).toFixed(2); // 3% de holgura
    const low = (minUsd * 0.9).toFixed(2); // 10% por debajo

    for (const src of ['usdc', 'usdt']) {
      const cases = [
        ['A actual   (amount + developer_fee)', (b) => ({ ...b, amount: (DEST_AMOUNT / sell).toFixed(2), developer_fee: DEV_FEE.toFixed(2) })],
        ['B solo destination.amount', (b) => ({ ...b, destination: { ...b.destination, amount: DEST_AMOUNT.toFixed(2) } })],
        ['C source+destination (holgura 3%)', (b) => ({ ...b, source: { ...b.source, amount: ok }, destination: { ...b.destination, amount: DEST_AMOUNT.toFixed(2) } })],
        ['D C + developer_fee', (b) => ({ ...b, source: { ...b.source, amount: ok }, destination: { ...b.destination, amount: DEST_AMOUNT.toFixed(2) }, developer_fee: DEV_FEE.toFixed(2) })],
        ['E source insuficiente (-10%)', (b) => ({ ...b, source: { ...b.source, amount: low }, destination: { ...b.destination, amount: DEST_AMOUNT.toFixed(2) }, developer_fee: DEV_FEE.toFixed(2) })],
      ];
      console.log(`  · origen ${src.toUpperCase()} (mínimo teórico ${minUsd.toFixed(2)} USD, C/D=${ok}, E=${low})`);
      for (const [label, build] of cases) {
        const r = await bridge('POST', '/v0/transfers', build(baseBody(customerId, walletId, src, account, rail)));
        console.log(`    ${label.padEnd(38)} ${summarize(r)}`);
      }
    }
    console.log('');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
