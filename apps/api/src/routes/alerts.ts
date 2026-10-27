import type { FastifyInstance } from 'fastify';
import type { Kysely, Selectable, Transaction, Updateable } from 'kysely';
import { z } from 'zod';
import {
  ALERT_KIND_PERMISSION, alertActions,
  type AlertActionKind, type AlertCategory, type AlertDetail, type AlertDto, type AlertKind, type AlertSummary,
} from '@ccih/domain';
import type { AlertTable, DB } from '../db/types';
import { audit } from '../audit/audit';
import { actorOf, requireAuth, requirePermission, type AuthContext } from '../http/auth';
import { HttpError, conflict, notFound, parse } from '../http/errors';
import { IsoDate, Justification, PageQuery, RowVersion, Text, Uuid } from '../http/schemas';
import { refreshAlerts, resetAlertThrottle } from '../services/alerts';

const CATEGORIES = ['erro_operacional', 'violacao_sequencia', 'pendencia_tempo', 'falha_integracao', 'informacao_obrigatoria', 'nao_conformidade', 'seguranca'] as const;
const ListQuery = z.object({
  status: z.enum(['abertos', 'aberto', 'reconhecido', 'assumido', 'resolvido', 'encerrado', 'todos']).default('abertos'),
  priority: z.enum(['critica', 'alta', 'media', 'baixa']).optional(),
  category: z.enum(CATEGORIES).optional(),
  kind: z.string().max(60).optional(),
  unitId: Uuid.optional(),
  sectorId: Uuid.optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  blocking: z.enum(['1']).optional(),
  mine: z.enum(['1']).optional(),
  ...PageQuery,
}).strict();
const VersionBody = z.object({ rowVersion: RowVersion }).strict();
const NoteBody = z.object({ note: Justification, rowVersion: RowVersion }).strict();
const CommentBody = z.object({ note: Text(1000) }).strict();
const CloseBody = z.object({ resolution: Justification, rowVersion: RowVersion }).strict();

/** Alert kinds the user may see (each kind follows the permission of its module). */
const visibleKinds = (auth: AuthContext) => (Object.keys(ALERT_KIND_PERMISSION) as AlertKind[]).filter((k) => auth.permissions.includes(ALERT_KIND_PERMISSION[k]));

const iso = (d: Date | null) => d?.toISOString() ?? null;

function toDto(a: Selectable<AlertTable>): AlertDto {
  return {
    id: a.id, kind: a.kind as AlertKind, priority: a.priority, status: a.status, title: a.title, detail: a.detail, entity: a.entity, entityId: a.entity_id, sectorId: a.sector_id,
    createdAt: a.created_at.toISOString(), lastSeenAt: a.last_seen_at.toISOString(), assignedName: a.assigned_name, assignedAt: iso(a.assigned_at),
    closedAt: iso(a.closed_at), closedByName: a.closed_by_name, resolution: a.resolution, rowVersion: a.row_version, link: a.link,
    category: a.category as AlertCategory, blocking: a.blocking, step: a.step, dueOn: a.due_on, unitId: a.unit_id,
    acknowledgedName: a.acknowledged_name, acknowledgedAt: iso(a.acknowledged_at), resolvedName: a.resolved_name, resolvedAt: iso(a.resolved_at), resolvedNote: a.resolved_note,
    closedReason: a.closed_reason,
  };
}

export async function alertRoutes(app: FastifyInstance, { db }: { db: Kysely<DB> }) {
  const view = { preHandler: requirePermission(db, 'alerts:view') };
  const manage = { preHandler: requirePermission(db, 'alerts:manage') };
  const exception = { preHandler: requirePermission(db, 'alerts:exception') };

  const base = (auth: AuthContext, q: Kysely<DB> | Transaction<DB> = db) => {
    const kinds = visibleKinds(auth);
    let list = q.selectFrom('alert').where('institution_id', '=', auth.institutionId).where('kind', 'in', kinds.length ? kinds : ['-']);
    if (auth.scope) {
      const scope = auth.scope.length ? auth.scope : ['00000000-0000-0000-0000-000000000000'];
      list = list.where((eb) => eb.or([eb('sector_id', 'is', null), eb('sector_id', 'in', scope)]));
    }
    // Consulting model: a consultant only sees the alerts of the clients assigned to them.
    if (auth.clientScope) {
      const clients = auth.clientScope.length ? auth.clientScope : ['00000000-0000-0000-0000-000000000000'];
      list = list.where((eb) => eb.or([eb('client_id', 'is', null), eb('client_id', 'in', clients)]));
    }
    return list;
  };

  const record = (trx: Kysely<DB> | Transaction<DB>, alertId: string, auth: AuthContext, action: AlertActionKind, note: string | null) =>
    trx.insertInto('alert_action').values({ alert_id: alertId, action, user_id: auth.userId, user_name: auth.displayName, note, at: new Date() }).execute();

  /**
   * One state change: locks the alert, checks visibility, version and the allowed action, applies it,
   * writes the history entry and the audit log in the same transaction.
   */
  const change = async (
    req: Parameters<typeof actorOf>[0], id: string, rowVersion: number, action: AlertActionKind, note: string | null,
    allowed: (a: Selectable<AlertTable>) => string | null, set: (a: Selectable<AlertTable>, auth: AuthContext, now: Date) => Updateable<AlertTable>,
  ) => {
    const auth = requireAuth(req);
    return db.transaction().execute(async (trx) => {
      const before = await base(auth, trx).selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!before) throw notFound('Alerta');
      if (before.row_version !== rowVersion) throw conflict();
      const refusal = allowed(before);
      if (refusal) throw new HttpError(409, 'alerta_acao_invalida', refusal);
      const now = new Date();
      const after = await trx.updateTable('alert').set({ ...set(before, auth, now), row_version: before.row_version + 1 }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await record(trx, id, auth, action, note);
      await audit(trx, actorOf(req), {
        action: 'update', entity: 'alert', entityId: id, before: { status: before.status, assigned: before.assigned_name }, after: { status: after.status, assigned: after.assigned_name },
        context: { acao: action, kind: before.kind, ...(note ? { justification: note } : {}) },
      });
      return { ok: true, rowVersion: after.row_version };
    });
  };

  app.get('/alerts', view, async (req) => {
    const auth = requireAuth(req);
    const q = parse(ListQuery, req.query);
    await refreshAlerts(db, auth.institutionId);
    let list = base(auth);
    if (q.status === 'abertos') list = list.where('status', '<>', 'encerrado');
    else if (q.status !== 'todos') list = list.where('status', '=', q.status);
    if (q.priority) list = list.where('priority', '=', q.priority);
    if (q.category) list = list.where('category', '=', q.category);
    if (q.kind) list = list.where('kind', '=', q.kind);
    if (q.unitId) list = list.where('unit_id', '=', q.unitId);
    if (q.sectorId) list = list.where('sector_id', '=', q.sectorId);
    if (q.blocking) list = list.where('blocking', '=', true);
    if (q.mine) list = list.where('assigned_to', '=', auth.userId);
    // Period on the creation date, read in UTC days at the API boundary (the UI sends whole days).
    if (q.from) list = list.where('created_at', '>=', new Date(`${q.from}T00:00:00Z`));
    if (q.to) list = list.where('created_at', '<', new Date(new Date(`${q.to}T00:00:00Z`).getTime() + 86_400_000));
    const [rows, total] = await Promise.all([
      // Closed alerts are history: most recently closed first. Open work: blocking, then by severity.
      (q.status === 'encerrado'
        ? list.selectAll().orderBy('closed_at', 'desc')
        : list.selectAll().orderBy('blocking', 'desc').orderBy((eb) => eb.case().when('priority', '=', 'critica').then(0).when('priority', '=', 'alta').then(1).when('priority', '=', 'media').then(2).else(3).end()))
        .orderBy('created_at', 'desc').limit(q.pageSize).offset((q.page - 1) * q.pageSize).execute(),
      list.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { rows: rows.map(toDto), total: Number(total.n), page: q.page, pageSize: q.pageSize };
  });

  app.get('/alerts/summary', view, async (req): Promise<AlertSummary> => {
    const auth = requireAuth(req);
    await refreshAlerts(db, auth.institutionId);
    const rows = await base(auth).where('status', '<>', 'encerrado')
      .select((eb) => ['priority', eb.fn.countAll<string>().as('n'), eb.fn.count<string>(eb.case().when('assigned_to', '=', auth.userId).then(1).end()).as('mine'), eb.fn.count<string>(eb.case().when('blocking', '=', true).then(1).end()).as('blocking')])
      .groupBy('priority').execute();
    const byPriority = { critica: 0, alta: 0, media: 0, baixa: 0 };
    let mine = 0;
    let blocking = 0;
    for (const r of rows) { byPriority[r.priority] = Number(r.n); mine += Number(r.mine); blocking += Number(r.blocking); }
    return { open: byPriority.critica + byPriority.alta + byPriority.media + byPriority.baixa, byPriority, assignedToMe: mine, blocking };
  });

  /** Detail with the full history. Opening it records "visualizado" once per user; it never changes the status. */
  app.get<{ Params: { id: string } }>('/alerts/:id', view, async (req): Promise<AlertDetail> => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const row = await base(auth).selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw notFound('Alerta');
    const seen = await db.selectFrom('alert_action').select('id').where('alert_id', '=', id).where('action', '=', 'visualizado').where('user_id', '=', auth.userId).executeTakeFirst();
    if (!seen) await record(db, id, auth, 'visualizado', null);
    const actions = await db.selectFrom('alert_action').selectAll().where('alert_id', '=', id).orderBy('at').execute();
    return { ...toDto(row), actions: actions.map((x) => ({ id: x.id, action: x.action, userName: x.user_name, note: x.note, at: x.at.toISOString() })) };
  });

  app.post('/alerts/refresh', manage, async (req) => {
    const auth = requireAuth(req);
    resetAlertThrottle(auth.institutionId);
    const r = await refreshAlerts(db, auth.institutionId, new Date(), true);
    await audit(db, actorOf(req), { action: 'update', entity: 'alert', entityId: null, context: { kind: 'atualizacao_manual', ...(r ?? {}) } });
    return { ok: true, ...(r ?? { created: 0, resolved: 0 }) };
  });

  const closed = 'O alerta já foi encerrado.';

  app.post<{ Params: { id: string } }>('/alerts/:id/acknowledge', manage, async (req) => {
    const b = parse(VersionBody, req.body);
    return change(req, parse(Uuid, req.params.id), b.rowVersion, 'reconhecido', null,
      (a) => (a.status === 'encerrado' ? closed : alertActions(a).acknowledge ? null : 'O alerta já foi reconhecido.'),
      (_a, auth, now) => ({ status: 'reconhecido', acknowledged_at: now, acknowledged_by: auth.userId, acknowledged_name: auth.displayName }));
  });

  app.post<{ Params: { id: string } }>('/alerts/:id/assume', manage, async (req) => {
    const b = parse(VersionBody, req.body);
    return change(req, parse(Uuid, req.params.id), b.rowVersion, 'assumido', null,
      (a) => (a.status === 'encerrado' ? closed : alertActions(a).assume ? null : 'O alerta já está sendo tratado.'),
      (a, auth, now) => ({
        status: 'assumido', assigned_to: auth.userId, assigned_name: auth.displayName, assigned_at: now,
        // Taking an alert also means having seen it.
        ...(a.acknowledged_at ? {} : { acknowledged_at: now, acknowledged_by: auth.userId, acknowledged_name: auth.displayName }),
      }));
  });

  /** What was done about the cause. A blocking alert stays open until its condition is gone. */
  app.post<{ Params: { id: string } }>('/alerts/:id/resolve', manage, async (req) => {
    const b = parse(NoteBody, req.body);
    return change(req, parse(Uuid, req.params.id), b.rowVersion, 'resolvido', b.note,
      (a) => (a.status === 'encerrado' ? closed : alertActions(a).resolve ? null : 'O alerta já foi resolvido.'),
      (_a, auth, now) => ({ status: 'resolvido', resolved_at: now, resolved_by: auth.userId, resolved_name: auth.displayName, resolved_note: b.note }));
  });

  /** Closing requires what was done; a blocking alert cannot be closed by hand while its condition persists. */
  app.post<{ Params: { id: string } }>('/alerts/:id/close', manage, async (req) => {
    const b = parse(CloseBody, req.body);
    return change(req, parse(Uuid, req.params.id), b.rowVersion, 'encerrado', b.resolution,
      (a) => (a.status === 'encerrado' ? closed : a.blocking ? 'Alerta bloqueante: a condição ainda existe no registro de origem. Corrija a causa (o alerta se encerra sozinho) ou registre uma exceção formal.' : null),
      (_a, auth, now) => ({ status: 'encerrado', closed_at: now, closed_by_name: auth.displayName, resolution: b.resolution, closed_reason: 'manual' }));
  });

  /** Formal exception: closes a blocking alert whose condition persists. The same condition is not raised again. */
  app.post<{ Params: { id: string } }>('/alerts/:id/exception', exception, async (req) => {
    const b = parse(NoteBody, req.body);
    return change(req, parse(Uuid, req.params.id), b.rowVersion, 'excecao', b.note,
      (a) => (a.status === 'encerrado' ? closed : a.blocking ? null : 'A exceção formal só se aplica a alertas bloqueantes; encerre o alerta normalmente.'),
      (_a, auth, now) => ({ status: 'encerrado', closed_at: now, closed_by_name: auth.displayName, resolution: `Exceção formal: ${b.note}`, closed_reason: 'excecao' }));
  });

  /** Comments add to the history without changing the alert. */
  app.post<{ Params: { id: string } }>('/alerts/:id/comments', manage, async (req, reply) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(CommentBody, req.body);
    const row = await base(auth).select('id').where('id', '=', id).executeTakeFirst();
    if (!row) throw notFound('Alerta');
    await record(db, id, auth, 'comentado', b.note);
    reply.code(201);
    return { ok: true };
  });
}
