import { Migrator, sql, type Kysely, type Migration, type MigrationProvider } from 'kysely';
import type { DB } from './types';
import * as m0001 from './migrations/0001_foundation';
import * as m0002 from './migrations/0002_clinical';
import * as m0003 from './migrations/0003_operations';
import * as m0004 from './migrations/0004_cme';
import * as m0005 from './migrations/0005_cme_flow';
import * as m0006 from './migrations/0006_cme_exit_nc';
import * as m0007 from './migrations/0007_alerts_v2';
import * as m0008 from './migrations/0008_event_outbox';
import * as m0009 from './migrations/0009_rbac_functions';

/** Migrations are registered statically (works the same under tsx, tests and the bundled build). */
const MIGRATIONS: Record<string, Migration> = {
  '0001_foundation': m0001,
  '0002_clinical': m0002,
  '0003_operations': m0003,
  '0004_cme': m0004,
  '0005_cme_flow': m0005,
  '0006_cme_exit_nc': m0006,
  '0007_alerts_v2': m0007,
  '0008_event_outbox': m0008,
  '0009_rbac_functions': m0009,
};

export const APPEND_ONLY_TABLES = [
  'iras_case_status', 'ccih_note', 'culture_result', 'isolate', 'susceptibility',
  'quality_audit_status', 'nonconformity_status', 'supply_movement', 'ssi_followup', 'bundle_audit_answer',
  'load_item', 'sterilization_test', 'load_release_decision', 'attachment', 'cme_scan_event', 'alert_action',
] as const;

const provider: MigrationProvider = { getMigrations: async () => MIGRATIONS };

export async function migrateToLatest(ownerDb: Kysely<DB>): Promise<string[]> {
  const { error, results } = await new Migrator({ db: ownerDb, provider }).migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}

/**
 * Least privilege for the runtime role: DML on business tables, INSERT/SELECT only on audit_log,
 * nothing on the migration bookkeeping tables, no DDL.
 */
export async function grantAppRole(ownerDb: Kysely<DB>, appRole: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(appRole)) throw new Error('Nome de papel inválido');
  const role = sql.id(appRole);
  await sql`GRANT USAGE ON SCHEMA public TO ${role}`.execute(ownerDb);
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`.execute(ownerDb);
  await sql`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`.execute(ownerDb);
  await sql`REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM ${role}`.execute(ownerDb);
  // Clinical history is append-only too (corrections are new rows); the triggers back this up.
  for (const table of APPEND_ONLY_TABLES) await sql`REVOKE UPDATE, DELETE, TRUNCATE ON ${sql.table(table)} FROM ${role}`.execute(ownerDb);
  await sql`REVOKE ALL ON kysely_migration, kysely_migration_lock FROM ${role}`.execute(ownerDb);
}

/** Drops everything (development and tests only). */
export async function resetSchema(ownerDb: Kysely<DB>): Promise<void> {
  await sql`DROP SCHEMA IF EXISTS public CASCADE`.execute(ownerDb);
  await sql`CREATE SCHEMA public`.execute(ownerDb);
}
