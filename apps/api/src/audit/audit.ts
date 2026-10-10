import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../db/types';
import { sha256 } from '../security/crypto';
import { publish, topicOfEntity } from '../realtime/outbox';

/**
 * Append-only audit log with a hash chain: each entry stores the previous hash, so any edit or
 * deletion outside the application is detectable (verifyAuditChain). The database also rejects
 * UPDATE/DELETE/TRUNCATE on the table, and the runtime role has no such privilege.
 */
export type AuditAction =
  | 'login_success' | 'login_failure' | 'logout' | 'session_expired' | 'access_denied'
  | 'create' | 'update' | 'delete' | 'validate' | 'unlock' | 'export' | 'seed'
  | 'status_change' | 'view_identified' | 'consolidate' | 'upload' | 'download';

export interface AuditActor {
  institutionId: string | null;
  userId: string | null;
  login: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface AuditEntry {
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  context?: Record<string, unknown>;
}

export const GENESIS_HASH = '0'.repeat(64);

/** Stable JSON (sorted keys) so the hash does not depend on key order or jsonb normalization. */
export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

interface HashedFields {
  occurredAt: string;
  institutionId: string | null;
  userId: string | null;
  userLogin: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  userAgent: string | null;
  context: unknown;
}

export const entryHash = (prevHash: string, f: HashedFields): string => sha256(prevHash + canonical(f));

async function append(trx: Transaction<DB>, actor: AuditActor, entry: AuditEntry): Promise<void> {
  // Serializes writers so the chain stays linear.
  await sql`SELECT pg_advisory_xact_lock(hashtext('ccih_audit_log'))`.execute(trx);
  const last = await trx.selectFrom('audit_log').select('hash').orderBy('id', 'desc').limit(1).executeTakeFirst();
  const prevHash = last?.hash ?? GENESIS_HASH;
  const fields: HashedFields = {
    occurredAt: new Date().toISOString(),
    institutionId: actor.institutionId,
    userId: actor.userId,
    userLogin: actor.login,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    ip: actor.ip,
    userAgent: actor.userAgent,
    context: entry.context ?? null,
  };
  const json = (v: unknown) => (v == null ? null : JSON.stringify(v));
  await trx
    .insertInto('audit_log')
    .values({
      occurred_at: fields.occurredAt,
      institution_id: fields.institutionId,
      user_id: fields.userId,
      user_login: fields.userLogin,
      action: fields.action,
      entity: fields.entity,
      entity_id: fields.entityId,
      before: json(fields.before),
      after: json(fields.after),
      ip: fields.ip,
      user_agent: fields.userAgent,
      context: json(fields.context),
      prev_hash: prevHash,
      hash: entryHash(prevHash, fields),
    })
    .execute();
  // Every audited change also tells the open screens to refresh (same transaction: only if it commits).
  const t = topicOfEntity(entry.entity);
  if (t && actor.institutionId && entry.action !== 'download' && entry.action !== 'view_identified' && entry.action !== 'access_denied') {
    await publish(trx, { institutionId: actor.institutionId, ...t });
  }
}

/** Writes inside the caller's transaction (same commit as the change) or in its own. */
export async function audit(db: Kysely<DB> | Transaction<DB>, actor: AuditActor, entry: AuditEntry): Promise<void> {
  if (db.isTransaction) return append(db as Transaction<DB>, actor, entry);
  await db.transaction().execute((trx) => append(trx, actor, entry));
}

export interface ChainCheck {
  ok: boolean;
  checked: number;
  brokenAtId: string | null;
}

/** Recomputes the whole chain (run periodically and on demand by auditors). */
export async function verifyAuditChain(db: Kysely<DB>): Promise<ChainCheck> {
  const rows = await db.selectFrom('audit_log').selectAll().orderBy('id', 'asc').execute();
  let prev = GENESIS_HASH;
  for (const r of rows) {
    const expected = entryHash(prev, {
      occurredAt: r.occurred_at.toISOString(),
      institutionId: r.institution_id,
      userId: r.user_id,
      userLogin: r.user_login,
      action: r.action,
      entity: r.entity,
      entityId: r.entity_id,
      before: r.before,
      after: r.after,
      ip: r.ip,
      userAgent: r.user_agent,
      context: r.context,
    });
    if (r.prev_hash !== prev || r.hash !== expected) return { ok: false, checked: rows.indexOf(r), brokenAtId: r.id };
    prev = r.hash;
  }
  return { ok: true, checked: rows.length, brokenAtId: null };
}
