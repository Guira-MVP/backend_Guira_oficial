import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Cada objeto de base de datos que el backend usa debe crearse en algún
 * archivo de `migrations/`. En la auditoría del 2026-09-23 se encontraron
 * columnas y funciones aplicadas a mano en la DB de staging sin archivo en
 * el repo: al promover el código a producción, todos los pagos a
 * beneficiarios habrían fallado por consultar `suppliers.compliance_status`.
 *
 * Cuando añadas código que dependa de un objeto nuevo, añádelo aquí junto
 * con su migración.
 */
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

const REQUIRED_DB_OBJECTS: Array<{ object: string; pattern: RegExp }> = [
  { object: 'tabla account_members', pattern: /create table[^;]*account_members/i },
  { object: 'columna suppliers.compliance_status', pattern: /add column[^;]*compliance_status/i },
  { object: 'columna suppliers.compliance_reason', pattern: /add column[^;]*compliance_reason/i },
  { object: 'columna suppliers.compliance_updated_at', pattern: /add column[^;]*compliance_updated_at/i },
  { object: 'función claim_suppliers_for_rescreening', pattern: /function public\.claim_suppliers_for_rescreening/i },
  { object: 'setting WALLET_SCREENING_ENABLED', pattern: /'WALLET_SCREENING_ENABLED'/ },
  { object: 'setting WALLET_RESCREENING_ENABLED', pattern: /'WALLET_RESCREENING_ENABLED'/ },
  { object: 'setting WALLET_RESCREENING_INTERVAL_DAYS', pattern: /'WALLET_RESCREENING_INTERVAL_DAYS'/ },
  { object: 'setting WALLET_RESCREENING_BATCH_SIZE', pattern: /'WALLET_RESCREENING_BATCH_SIZE'/ },
  { object: 'tabla private.corporate_signup_allowlist', pattern: /create table[^;]*corporate_signup_allowlist/i },
  { object: 'columna profiles.phone en handle_new_user', pattern: /function public\.handle_new_user[\s\S]*raw_user_meta_data ->> 'phone'/i },
  { object: 'tabla onboarding_drafts', pattern: /create table[^;]*onboarding_drafts/i },
  { object: 'columna documents.draft_key', pattern: /alter table public\.documents add column[^;]*draft_key/i },
  { object: 'columna documents.is_draft', pattern: /alter table public\.documents add column[^;]*is_draft/i },
];

describe('migrations/ cubre los objetos de base de datos que usa el backend', () => {
  const allSql = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    .join('\n');

  it.each(REQUIRED_DB_OBJECTS)('existe una migración para: $object', ({ pattern }) => {
    expect(allSql).toMatch(pattern);
  });

  it('las columnas de compliance se crean antes que la función que las usa', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const column = files.findIndex((f) =>
      /add column[^;]*compliance_status/i.test(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')),
    );
    const fn = files.findIndex((f) =>
      /function public\.claim_suppliers_for_rescreening/i.test(
        readFileSync(join(MIGRATIONS_DIR, f), 'utf8'),
      ),
    );

    expect(column).toBeGreaterThanOrEqual(0);
    expect(fn).toBeGreaterThan(column);
  });
});
