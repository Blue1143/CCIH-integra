import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { ROLE_MODULE, type RoleCode } from '@ccih/domain';
import { auditEntitiesOf } from '../realtime/outbox';
import type { DB } from '../db/types';
import { audit, verifyAuditChain } from '../audit/audit';
import { actorOf, requireAuth, requirePermission } from '../http/auth';
import { parse } from '../http/errors';

const AuditQuery = z
  .object({
    entity: z.string().max(60).optional(),
    action: z.string().max(40).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(10).max(100).default(25),
  })
  .strict();

export async function adminRoutes(app: FastifyInstance, { db }: { db: Kysely<DB> }) {
  /* ---------- Audit log ---------- */
  app.get('/audit', { preHandler: requirePermission(db, 'audit:view', 'audit:view:module') }, async (req) => {
    const auth = requireAuth(req);
    const q = parse(AuditQuery, req.query);
    let base = db.selectFrom('audit_log').where('institution_id', '=', auth.institutionId);
    // A module administrator reads only the events of its module's records.
    if (!auth.permissions.includes('audit:view')) {
      const modules = [...new Set(auth.roles.map((r) => ROLE_MODULE[r as RoleCode]).filter((m) => m === 'cme' || m === 'ccih'))];
      const entities = auditEntitiesOf(modules);
      // Parameters belong to the module of their group (cme.* to the CME, the others to the CCIH).
      base = base.where((eb) => eb.or([
        eb('entity', 'in', entities.length ? entities : ['-']),
        ...(modules.includes('cme') ? [eb.and([eb('entity', '=', 'rule_parameter'), eb('entity_id', 'like', 'cme.%')])] : []),
        ...(modules.includes('ccih') ? [eb.and([eb('entity', '=', 'rule_parameter'), eb('entity_id', 'not like', 'cme.%')]), eb('entity', 'in', ['indicator_target', 'clinical_reference'])] : []),
      ]));
    }
    if (q.entity) base = base.where('entity', '=', q.entity);
    if (q.action) base = base.where('action', '=', q.action);
    const [rows, total] = await Promise.all([
      base.select(['id', 'occurred_at', 'user_login', 'action', 'entity', 'entity_id', 'before', 'after', 'ip', 'context']).orderBy('id', 'desc').limit(q.pageSize).offset((q.page - 1) * q.pageSize).execute(),
      base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { rows: rows.map((r) => ({ ...r, occurred_at: r.occurred_at.toISOString() })), total: Number(total.n), page: q.page, pageSize: q.pageSize };
  });

  app.get('/audit/verify', { preHandler: requirePermission(db, 'audit:view') }, async (req) => {
    const result = await verifyAuditChain(db);
    await audit(db, actorOf(req), { action: 'validate', entity: 'audit_log', entityId: null, context: { ok: result.ok, checked: result.checked } });
    return result;
  });
}
