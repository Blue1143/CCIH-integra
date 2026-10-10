import type { FastifyInstance } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import {
  addDays, checkAuditTransition, checkNcTransition, evaluateBundle, todayIn, zonedInstant,
  type ActionPlanDto, type AuditStatus, type BundleAuditDto, type BundleSummary, type BundleTemplateDto, type HandHygieneDto, type HandHygieneSummaryRow,
  type NcStatus, type NonconformityDetail, type NonconformityDto, type QualityAuditDetail, type QualityAuditDto, type StatusEntryDto, type Paged,
} from '@ccih/domain';
import type { DB } from '../db/types';
import { audit } from '../audit/audit';
import { actorOf, requireAuth, requirePermission, type AuthContext } from '../http/auth';
import { HttpError, conflict, notFound, parse } from '../http/errors';
import { Instant, IsoDate, Justification, OptionalText, PageQuery, RowVersion, Text, Uuid, notFuture } from '../http/schemas';
import { assertSector, findAdmission, institutionOrigin, scopeIds } from '../repositories/clinical';

const ANSWER = z.enum(['conforme', 'nao_conforme', 'nao_aplicavel']);
const TemplateBody = z
  .object({
    code: z.string().regex(/^[a-z0-9-]{2,40}$/, 'Use letras minúsculas, números e hífen.'),
    name: Text(160),
    metric: z.enum(['cvc', 'vm', 'svd']).nullable(),
    method: z.enum(['tudo_ou_nada', 'por_item']),
    referenceId: Uuid.nullable(),
    active: z.boolean(),
    items: z.array(z.object({ id: Uuid.nullable(), label: Text(200) }).strict()).min(1).max(30),
    rowVersion: RowVersion.nullable(),
    justification: Justification,
  })
  .strict();
const AuditCreate = z
  .object({ templateId: Uuid, sectorId: Uuid, admissionId: Uuid.nullable(), auditedAt: Instant, notes: OptionalText(1000), answers: z.array(z.object({ itemId: Uuid, answer: ANSWER }).strict()).min(1).max(30) })
  .strict();
const VoidBody = z.object({ reason: Justification }).strict();
const HhCreate = z
  .object({ sectorId: Uuid, observedAt: Instant, category: z.enum(['enfermagem', 'medica', 'fisioterapia', 'apoio', 'outros']), opportunities: z.number().int().min(1).max(500), actions: z.number().int().min(0).max(500) })
  .strict()
  .refine((b) => b.actions <= b.opportunities, { message: 'Ações não podem superar oportunidades.', path: ['actions'] });
const RangeQuery = z.object({ from: IsoDate.optional(), to: IsoDate.optional(), sectorId: Uuid.optional(), templateId: Uuid.optional(), ...PageQuery }).strict();

const QaCreate = z.object({ title: Text(200), kind: z.enum(['processo', 'estrutura', 'documental', 'outro']), sectorId: Uuid.nullable(), scope: OptionalText(1000), plannedFor: IsoDate, justification: Justification }).strict();
const QaUpdate = z.object({ title: Text(200), scope: OptionalText(1000), plannedFor: IsoDate, findings: OptionalText(4000), rowVersion: RowVersion, justification: Justification }).strict();
const QaStatus = z.object({ to: z.enum(['planejada', 'em_andamento', 'concluida', 'plano_de_acao', 'verificacao_eficacia', 'encerrada', 'cancelada']), justification: Justification, rowVersion: RowVersion }).strict();
const NcCreate = z
  .object({ auditId: Uuid.nullable(), sectorId: Uuid.nullable(), origin: z.enum(['auditoria', 'bundle', 'higiene_maos', 'cme', 'notificacao', 'outro']), severity: z.enum(['baixa', 'media', 'alta']), description: Text(2000), detectedOn: IsoDate, justification: Justification })
  .strict();
const NcStatusBody = z.object({ to: z.enum(['aberta', 'em_tratamento', 'aguardando_eficacia', 'encerrada', 'cancelada']), effectiveness: OptionalText(2000), justification: Justification, rowVersion: RowVersion }).strict();
const ActionCreate = z.object({ what: Text(300), why: Text(500), where: Text(200), who: Text(160), dueOn: IsoDate, how: Text(1000), howMuch: OptionalText(120) }).strict();
const ActionStatusBody = z.object({ status: z.enum(['pendente', 'em_andamento', 'concluida', 'cancelada']), completedOn: IsoDate.nullable(), rowVersion: RowVersion, justification: Justification }).strict();

const fieldError = (path: string, message: string) => new HttpError(400, 'validacao', message, [{ path, message }]);

async function tzOf(db: Kysely<DB> | Transaction<DB>, institutionId: string) {
  return (await db.selectFrom('institution').select('timezone').where('id', '=', institutionId).executeTakeFirstOrThrow()).timezone;
}

/** Sector-bound or institution-wide record: institution-wide ones are visible to everyone with the permission. */
const inScope = (auth: AuthContext, sectorId: string | null) => !auth.scope || sectorId == null || auth.scope.includes(sectorId);

export async function qualityRoutes(app: FastifyInstance, { db }: { db: Kysely<DB> }) {
  const view = { preHandler: requirePermission(db, 'quality:view') };
  // Checklists (bundles, hand hygiene) are recorded by the operational teams; audits are conducted by
  // Quality; anyone with nc:record may register a non-conformity, only Quality treats and closes it.
  const checklist = { preHandler: requirePermission(db, 'quality:bundle:record') };
  const manage = { preHandler: requirePermission(db, 'quality:audit:manage') };
  const execute = { preHandler: requirePermission(db, 'quality:audit:execute', 'quality:audit:manage') };
  const ncRecord = { preHandler: requirePermission(db, 'nc:record', 'quality:audit:manage') };
  const configure = { preHandler: requirePermission(db, 'quality:configure') };

  const range = async (auth: AuthContext, from?: string, to?: string) => {
    const tz = await tzOf(db, auth.institutionId);
    return { from: from ? zonedInstant(from, 0, tz) : undefined, to: to ? zonedInstant(addDays(to, 1), 0, tz) : undefined };
  };

  /* ---------- Bundle templates ---------- */

  async function templates(institutionId: string): Promise<BundleTemplateDto[]> {
    const [rows, items] = await Promise.all([
      db.selectFrom('bundle_template').selectAll().where('institution_id', '=', institutionId).orderBy('name').execute(),
      db.selectFrom('bundle_item').innerJoin('bundle_template', 'bundle_template.id', 'bundle_item.template_id').selectAll('bundle_item').where('bundle_template.institution_id', '=', institutionId).where('bundle_item.active', '=', true).orderBy('bundle_item.position').execute(),
    ]);
    return rows.map((t) => ({
      id: t.id, code: t.code, name: t.name, metric: t.metric, method: t.method, referenceId: t.reference_id, active: t.active, rowVersion: t.row_version,
      items: items.filter((i) => i.template_id === t.id).map((i) => ({ id: i.id, position: i.position, label: i.label })),
    }));
  }

  app.get('/bundles/templates', view, async (req) => ({ templates: await templates(requireAuth(req).institutionId) }));

  /** Create (rowVersion null) or replace a template; items removed are deactivated, past audits keep their labels. */
  app.put('/bundles/templates', configure, async (req) => {
    const auth = requireAuth(req);
    const b = parse(TemplateBody, req.body);
    return db.transaction().execute(async (trx) => {
      if (b.referenceId && !(await trx.selectFrom('clinical_reference').select('id').where('id', '=', b.referenceId).where('institution_id', '=', auth.institutionId).executeTakeFirst())) throw fieldError('referenceId', 'Referência inexistente.');
      const before = await trx.selectFrom('bundle_template').selectAll().where('institution_id', '=', auth.institutionId).where('code', '=', b.code).forUpdate().executeTakeFirst();
      if (before ? before.row_version !== b.rowVersion : b.rowVersion !== null) throw conflict();
      if (b.metric && b.active) {
        const other = await trx.selectFrom('bundle_template').select('id').where('institution_id', '=', auth.institutionId).where('metric', '=', b.metric).where('active', '=', true).where('code', '!=', b.code).executeTakeFirst();
        if (other) throw fieldError('metric', 'Já existe um modelo ativo para este indicador. Desative-o antes.');
      }
      const values = { name: b.name, metric: b.metric, method: b.method, reference_id: b.referenceId, active: b.active, updated_at: new Date() };
      const tpl = before
        ? await trx.updateTable('bundle_template').set({ ...values, row_version: before.row_version + 1 }).where('id', '=', before.id).returningAll().executeTakeFirstOrThrow()
        : await trx.insertInto('bundle_template').values({ ...values, institution_id: auth.institutionId, code: b.code }).returningAll().executeTakeFirstOrThrow();
      const current = await trx.selectFrom('bundle_item').selectAll().where('template_id', '=', tpl.id).where('active', '=', true).execute();
      const keep = new Set(b.items.map((i) => i.id).filter(Boolean));
      for (const i of current) if (!keep.has(i.id)) await trx.updateTable('bundle_item').set({ active: false }).where('id', '=', i.id).execute();
      for (const [position, item] of b.items.entries()) {
        const existing = item.id ? current.find((c) => c.id === item.id) : undefined;
        if (item.id && !existing) throw fieldError('items', 'Item inexistente neste modelo.');
        if (existing && existing.label !== item.label) {
          // A changed text is a new item: answers already given keep the old wording.
          await trx.updateTable('bundle_item').set({ active: false }).where('id', '=', existing.id).execute();
          await trx.insertInto('bundle_item').values({ template_id: tpl.id, position, label: item.label }).execute();
        } else if (existing) await trx.updateTable('bundle_item').set({ position }).where('id', '=', existing.id).execute();
        else await trx.insertInto('bundle_item').values({ template_id: tpl.id, position, label: item.label }).execute();
      }
      await audit(trx, actorOf(req), { action: before ? 'update' : 'create', entity: 'bundle_template', entityId: tpl.id, before: before ? { ...before, items: current.map((c) => c.label) } : null, after: { ...tpl, items: b.items.map((i) => i.label) }, context: { justification: b.justification } });
      return { ok: true, id: tpl.id, rowVersion: tpl.row_version };
    });
  });

  /* ---------- Bundle audits ---------- */

  app.get('/bundles/audits', view, async (req): Promise<Paged<BundleAuditDto>> => {
    const auth = requireAuth(req);
    const q = parse(RangeQuery, req.query);
    const r = await range(auth, q.from, q.to);
    let base = db.selectFrom('bundle_audit as a').innerJoin('bundle_template as t', 't.id', 'a.template_id').where('a.institution_id', '=', auth.institutionId);
    if (auth.scope) base = base.where('a.sector_id', 'in', scopeIds(auth.scope));
    if (q.sectorId) base = base.where('a.sector_id', '=', q.sectorId);
    if (q.templateId) base = base.where('a.template_id', '=', q.templateId);
    if (r.from) base = base.where('a.audited_at', '>=', r.from);
    if (r.to) base = base.where('a.audited_at', '<', r.to);
    const [rows, total] = await Promise.all([
      base.selectAll('a').select('t.name as template_name').orderBy('a.audited_at', 'desc').limit(q.pageSize).offset((q.page - 1) * q.pageSize).execute(),
      base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    const answers = rows.length ? await db.selectFrom('bundle_audit_answer').selectAll().where('audit_id', 'in', rows.map((r) => r.id)).execute() : [];
    return {
      rows: rows.map((a) => ({
        id: a.id, templateId: a.template_id, templateName: a.template_name, sectorId: a.sector_id, auditedAt: a.audited_at.toISOString(), result: a.result, method: a.method,
        notes: a.notes, auditorName: a.auditor_name, voided: a.voided_at != null, voidReason: a.void_reason, origin: a.data_origin,
        answers: answers.filter((x) => x.audit_id === a.id).map((x) => ({ itemId: x.item_id, label: x.item_label, answer: x.answer })),
      })),
      total: Number(total.n), page: q.page, pageSize: q.pageSize,
    };
  });

  app.post('/bundles/audits', checklist, async (req, reply) => {
    const auth = requireAuth(req);
    const b = parse(AuditCreate, req.body);
    await assertSector(db, auth, b.sectorId);
    if (!notFuture(b.auditedAt)) throw fieldError('auditedAt', 'A auditoria não pode estar no futuro.');
    if (b.admissionId) await findAdmission(db, auth, b.admissionId);
    const tpl = await db.selectFrom('bundle_template').selectAll().where('id', '=', b.templateId).where('institution_id', '=', auth.institutionId).where('active', '=', true).executeTakeFirst();
    if (!tpl) throw fieldError('templateId', 'Modelo inexistente ou inativo.');
    const items = await db.selectFrom('bundle_item').selectAll().where('template_id', '=', tpl.id).where('active', '=', true).orderBy('position').execute();
    const given = new Map(b.answers.map((a) => [a.itemId, a.answer]));
    if (given.size !== items.length || items.some((i) => !given.has(i.id))) throw fieldError('answers', 'Responda todos os itens do modelo (conforme, não conforme ou não se aplica).');
    const evaluation = evaluateBundle(items.map((i) => given.get(i.id)!), tpl.method);
    if (evaluation.result === 'incompleto') throw fieldError('answers', 'Responda todos os itens do modelo.');
    if (!evaluation.applicable) throw fieldError('answers', 'Ao menos um item precisa ser aplicável.');
    const created = await db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('bundle_audit')
        .values({ institution_id: auth.institutionId, template_id: tpl.id, sector_id: b.sectorId, admission_id: b.admissionId, audited_at: b.auditedAt, method: tpl.method, result: evaluation.result as 'conforme' | 'nao_conforme', notes: b.notes, auditor_id: auth.userId, auditor_name: auth.displayName, voided_at: null, voided_by_name: null, void_reason: null, data_origin: await institutionOrigin(trx, auth.institutionId) })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx.insertInto('bundle_audit_answer').values(items.map((i) => ({ audit_id: row.id, item_id: i.id, item_label: i.label, answer: given.get(i.id)! }))).execute();
      await audit(trx, actorOf(req), { action: 'create', entity: 'bundle_audit', entityId: row.id, after: { ...row, answers: Object.fromEntries(given) } });
      return row;
    });
    reply.code(201);
    return { id: created.id, result: created.result, nonCompliant: evaluation.nonCompliant };
  });

  /** Records are never deleted: a void keeps the audit visible, out of the indicators, with the reason. */
  app.post<{ Params: { id: string } }>('/bundles/audits/:id/void', checklist, async (req) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const { reason } = parse(VoidBody, req.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('bundle_audit').selectAll().where('id', '=', id).where('institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst();
      if (!before || !inScope(auth, before.sector_id)) throw notFound('Auditoria');
      if (before.voided_at) throw new HttpError(409, 'ja_anulada', 'Este registro já foi anulado.');
      const after = await trx.updateTable('bundle_audit').set({ voided_at: new Date(), voided_by_name: auth.displayName, void_reason: reason }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'update', entity: 'bundle_audit', entityId: id, before, after, context: { justification: reason, kind: 'anulacao' } });
      return { ok: true };
    });
  });

  app.get('/bundles/summary', view, async (req): Promise<BundleSummary> => {
    const auth = requireAuth(req);
    const q = parse(RangeQuery, req.query);
    const r = await range(auth, q.from, q.to);
    let base = db.selectFrom('bundle_audit as a').where('a.institution_id', '=', auth.institutionId).where('a.voided_at', 'is', null);
    if (auth.scope) base = base.where('a.sector_id', 'in', scopeIds(auth.scope));
    if (q.sectorId) base = base.where('a.sector_id', '=', q.sectorId);
    if (r.from) base = base.where('a.audited_at', '>=', r.from);
    if (r.to) base = base.where('a.audited_at', '<', r.to);
    const [rows, pareto] = await Promise.all([
      base.select((eb) => ['a.template_id', 'a.sector_id', eb.fn.countAll<string>().as('n'), eb.fn.count<string>(eb.case().when('a.result', '=', 'conforme').then(1).end()).as('ok')]).groupBy(['a.template_id', 'a.sector_id']).execute(),
      base.innerJoin('bundle_audit_answer as x', 'x.audit_id', 'a.id').select((eb) => ['a.template_id', 'x.item_id', 'x.item_label', eb.fn.countAll<string>().as('n')]).where('x.answer', '=', 'nao_conforme').groupBy(['a.template_id', 'x.item_id', 'x.item_label']).execute(),
    ]);
    return {
      rows: rows.map((x) => ({ templateId: x.template_id, sectorId: x.sector_id, audits: Number(x.n), compliant: Number(x.ok) })),
      pareto: pareto.map((x) => ({ templateId: x.template_id, itemId: x.item_id, label: x.item_label, nonCompliant: Number(x.n) })).sort((a, b) => b.nonCompliant - a.nonCompliant),
    };
  });

  /* ---------- Hand hygiene ---------- */

  app.get('/hand-hygiene', view, async (req): Promise<Paged<HandHygieneDto> & { summary: HandHygieneSummaryRow[] }> => {
    const auth = requireAuth(req);
    const q = parse(RangeQuery, req.query);
    const r = await range(auth, q.from, q.to);
    let base = db.selectFrom('hand_hygiene_observation').where('institution_id', '=', auth.institutionId);
    if (auth.scope) base = base.where('sector_id', 'in', scopeIds(auth.scope));
    if (q.sectorId) base = base.where('sector_id', '=', q.sectorId);
    if (r.from) base = base.where('observed_at', '>=', r.from);
    if (r.to) base = base.where('observed_at', '<', r.to);
    const [rows, total, summary] = await Promise.all([
      base.selectAll().orderBy('observed_at', 'desc').limit(q.pageSize).offset((q.page - 1) * q.pageSize).execute(),
      base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      base.where('voided_at', 'is', null).select((eb) => ['sector_id', 'category', eb.fn.sum<string>('opportunities').as('o'), eb.fn.sum<string>('actions').as('a')]).groupBy(['sector_id', 'category']).execute(),
    ]);
    return {
      rows: rows.map((h) => ({ id: h.id, sectorId: h.sector_id, observedAt: h.observed_at.toISOString(), category: h.category, opportunities: h.opportunities, actions: h.actions, observerName: h.observer_name, voided: h.voided_at != null, voidReason: h.void_reason, origin: h.data_origin })),
      total: Number(total.n), page: q.page, pageSize: q.pageSize,
      summary: summary.map((s) => ({ sectorId: s.sector_id, category: s.category, opportunities: Number(s.o), actions: Number(s.a) })),
    };
  });

  app.post('/hand-hygiene', checklist, async (req, reply) => {
    const auth = requireAuth(req);
    const b = parse(HhCreate, req.body);
    await assertSector(db, auth, b.sectorId);
    if (!notFuture(b.observedAt)) throw fieldError('observedAt', 'A observação não pode estar no futuro.');
    const row = await db.transaction().execute(async (trx) => {
      const created = await trx.insertInto('hand_hygiene_observation').values({ institution_id: auth.institutionId, sector_id: b.sectorId, observed_at: b.observedAt, category: b.category, opportunities: b.opportunities, actions: b.actions, observer_id: auth.userId, observer_name: auth.displayName, voided_at: null, voided_by_name: null, void_reason: null, data_origin: await institutionOrigin(trx, auth.institutionId) }).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'create', entity: 'hand_hygiene_observation', entityId: created.id, after: created });
      return created;
    });
    reply.code(201);
    return { id: row.id };
  });

  app.post<{ Params: { id: string } }>('/hand-hygiene/:id/void', checklist, async (req) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const { reason } = parse(VoidBody, req.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('hand_hygiene_observation').selectAll().where('id', '=', id).where('institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst();
      if (!before || !inScope(auth, before.sector_id)) throw notFound('Observação');
      if (before.voided_at) throw new HttpError(409, 'ja_anulada', 'Este registro já foi anulado.');
      const after = await trx.updateTable('hand_hygiene_observation').set({ voided_at: new Date(), voided_by_name: auth.displayName, void_reason: reason }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'update', entity: 'hand_hygiene_observation', entityId: id, before, after, context: { justification: reason, kind: 'anulacao' } });
      return { ok: true };
    });
  });

  /* ---------- Quality audits ---------- */

  const history = async (table: 'quality_audit_status' | 'nonconformity_status', column: 'audit_id' | 'nonconformity_id', id: string): Promise<StatusEntryDto[]> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same shape in both history tables
    const rows = await (db.selectFrom(table as any).selectAll() as any).where(column, '=', id).orderBy('at').execute() as Array<{ id: string; from_status: string | null; to_status: string; at: Date; decided_by_name: string; justification: string }>;
    return rows.map((h) => ({ id: h.id, from: h.from_status, to: h.to_status, at: h.at.toISOString(), by: h.decided_by_name, justification: h.justification }));
  };

  async function auditDtos(auth: AuthContext, ids?: string[]): Promise<QualityAuditDto[]> {
    let q = db.selectFrom('quality_audit').selectAll().where('institution_id', '=', auth.institutionId);
    if (ids) q = q.where('id', 'in', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
    const rows = (await q.orderBy('planned_for', 'desc').execute()).filter((a) => inScope(auth, a.sector_id));
    const ncs = rows.length ? await db.selectFrom('nonconformity').select(['audit_id', 'status']).where('audit_id', 'in', rows.map((r) => r.id)).execute() : [];
    return rows.map((a) => ({
      id: a.id, title: a.title, kind: a.kind, sectorId: a.sector_id, scope: a.scope, plannedFor: a.planned_for, status: a.status, findings: a.findings, rowVersion: a.row_version, origin: a.data_origin,
      nonconformities: ncs.filter((n) => n.audit_id === a.id).length, openNonconformities: ncs.filter((n) => n.audit_id === a.id && n.status !== 'encerrada' && n.status !== 'cancelada').length, updatedAt: a.updated_at.toISOString(),
    }));
  }

  async function ncDtos(auth: AuthContext, filter: { ids?: string[]; auditId?: string; status?: string[] } = {}): Promise<NonconformityDto[]> {
    let q = db.selectFrom('nonconformity as n').leftJoin('quality_audit as a', 'a.id', 'n.audit_id').selectAll('n').select('a.title as audit_title').where('n.institution_id', '=', auth.institutionId);
    if (filter.ids) q = q.where('n.id', 'in', filter.ids.length ? filter.ids : ['00000000-0000-0000-0000-000000000000']);
    if (filter.auditId) q = q.where('n.audit_id', '=', filter.auditId);
    if (filter.status?.length) q = q.where('n.status', 'in', filter.status as NcStatus[]);
    const rows = (await q.orderBy('n.detected_on', 'desc').execute()).filter((n) => inScope(auth, n.sector_id));
    const actions = rows.length ? await db.selectFrom('action_plan').select(['nonconformity_id', 'status', 'due_on']).where('nonconformity_id', 'in', rows.map((r) => r.id)).execute() : [];
    const today = todayIn(await tzOf(db, auth.institutionId));
    return rows.map((n) => {
      const mine = actions.filter((x) => x.nonconformity_id === n.id);
      const open = mine.filter((x) => x.status === 'pendente' || x.status === 'em_andamento');
      return {
        id: n.id, auditId: n.audit_id, auditTitle: n.audit_title, sectorId: n.sector_id, origin: n.origin, severity: n.severity, description: n.description, detectedOn: n.detected_on,
        status: n.status, effectiveness: n.effectiveness, rowVersion: n.row_version, dataOrigin: n.data_origin, actionsTotal: mine.length, actionsOpen: open.length, actionsOverdue: open.filter((x) => x.due_on < today).length,
        source: n.source_entity && n.source_id ? { entity: n.source_entity, id: n.source_id } : null, notifiedUserName: n.notified_user_name,
      };
    });
  }

  app.get('/quality/audits', view, async (req) => ({ audits: await auditDtos(requireAuth(req)) }));

  app.get<{ Params: { id: string } }>('/quality/audits/:id', view, async (req): Promise<QualityAuditDetail> => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const [dto] = await auditDtos(auth, [id]);
    if (!dto) throw notFound('Auditoria');
    return { ...dto, history: await history('quality_audit_status', 'audit_id', id), ncs: await ncDtos(auth, { auditId: id }) };
  });

  app.post('/quality/audits', manage, async (req, reply) => {
    const auth = requireAuth(req);
    const b = parse(QaCreate, req.body);
    if (b.sectorId) await assertSector(db, auth, b.sectorId);
    else if (auth.scope) throw fieldError('sectorId', 'Selecione um dos seus setores.');
    const row = await db.transaction().execute(async (trx) => {
      const created = await trx.insertInto('quality_audit').values({ institution_id: auth.institutionId, title: b.title, kind: b.kind, sector_id: b.sectorId, scope: b.scope, planned_for: b.plannedFor, status: 'planejada', findings: null, data_origin: await institutionOrigin(trx, auth.institutionId), created_by: auth.userId, updated_at: new Date() }).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto('quality_audit_status').values({ audit_id: created.id, from_status: null, to_status: 'planejada', justification: b.justification, decided_by: auth.userId, decided_by_name: auth.displayName, at: new Date() }).execute();
      await audit(trx, actorOf(req), { action: 'create', entity: 'quality_audit', entityId: created.id, after: created, context: { justification: b.justification } });
      return created;
    });
    reply.code(201);
    return { id: row.id };
  });

  app.put<{ Params: { id: string } }>('/quality/audits/:id', manage, async (req) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(QaUpdate, req.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('quality_audit').selectAll().where('id', '=', id).where('institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst();
      if (!before || !inScope(auth, before.sector_id)) throw notFound('Auditoria');
      if (before.row_version !== b.rowVersion) throw conflict();
      if (before.status === 'encerrada' || before.status === 'cancelada') throw new HttpError(409, 'auditoria_encerrada', 'Auditoria encerrada não pode ser alterada.');
      const after = await trx.updateTable('quality_audit').set({ title: b.title, scope: b.scope, planned_for: b.plannedFor, findings: b.findings, updated_at: new Date(), row_version: before.row_version + 1 }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'update', entity: 'quality_audit', entityId: id, before, after, context: { justification: b.justification } });
      return { ok: true, rowVersion: after.row_version };
    });
  });

  app.post<{ Params: { id: string } }>('/quality/audits/:id/status', manage, async (req) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(QaStatus, req.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('quality_audit').selectAll().where('id', '=', id).where('institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst();
      if (!before || !inScope(auth, before.sector_id)) throw notFound('Auditoria');
      if (before.row_version !== b.rowVersion) throw conflict();
      const problems = checkAuditTransition(before.status, b.to as AuditStatus, { justification: b.justification, findings: before.findings });
      if (b.to === 'encerrada' || b.to === 'verificacao_eficacia') {
        const open = await trx.selectFrom('nonconformity').select('id').where('audit_id', '=', id).where('status', 'not in', ['encerrada', 'cancelada', ...(b.to === 'verificacao_eficacia' ? ['aguardando_eficacia' as const] : [])]).executeTakeFirst();
        if (open) problems.push({ path: 'status', message: b.to === 'encerrada' ? 'Encerre ou cancele as não conformidades da auditoria antes.' : 'As não conformidades precisam estar aguardando eficácia ou encerradas.' });
      }
      if (problems.length) throw new HttpError(400, 'validacao', 'Não é possível concluir esta etapa. Revise os campos indicados.', problems);
      const after = await trx.updateTable('quality_audit').set({ status: b.to, updated_at: new Date(), row_version: before.row_version + 1 }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto('quality_audit_status').values({ audit_id: id, from_status: before.status, to_status: b.to, justification: b.justification, decided_by: auth.userId, decided_by_name: auth.displayName, at: new Date() }).execute();
      await audit(trx, actorOf(req), { action: 'status_change', entity: 'quality_audit', entityId: id, before, after, context: { justification: b.justification } });
      return { ok: true, rowVersion: after.row_version };
    });
  });

  /* ---------- Non-conformities and 5W2H ---------- */

  app.get('/quality/nonconformities', view, async (req) => {
    const auth = requireAuth(req);
    const { status } = parse(z.object({ status: z.string().max(100).optional() }).strict(), req.query);
    return { nonconformities: await ncDtos(auth, { status: status ? status.split(',') : undefined }) };
  });

  app.get<{ Params: { id: string } }>('/quality/nonconformities/:id', view, async (req): Promise<NonconformityDetail> => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const [dto] = await ncDtos(auth, { ids: [id] });
    if (!dto) throw notFound('Não conformidade');
    const today = todayIn(await tzOf(db, auth.institutionId));
    const actions = await db.selectFrom('action_plan').selectAll().where('nonconformity_id', '=', id).orderBy('due_on').execute();
    return {
      ...dto, history: await history('nonconformity_status', 'nonconformity_id', id),
      actions: actions.map((a): ActionPlanDto => ({ id: a.id, what: a.what, why: a.why, where: a.where_text, who: a.who_name, dueOn: a.due_on, how: a.how, howMuch: a.how_much, status: a.status, completedOn: a.completed_on, rowVersion: a.row_version, overdue: (a.status === 'pendente' || a.status === 'em_andamento') && a.due_on < today })),
    };
  });

  app.post('/quality/nonconformities', ncRecord, async (req, reply) => {
    const auth = requireAuth(req);
    const b = parse(NcCreate, req.body);
    if (b.sectorId) await assertSector(db, auth, b.sectorId);
    else if (auth.scope) throw fieldError('sectorId', 'Selecione um dos seus setores.');
    if (b.detectedOn > todayIn(await tzOf(db, auth.institutionId))) throw fieldError('detectedOn', 'A data não pode estar no futuro.');
    if (b.auditId) {
      const a = await db.selectFrom('quality_audit').select(['sector_id', 'status']).where('id', '=', b.auditId).where('institution_id', '=', auth.institutionId).executeTakeFirst();
      if (!a || !inScope(auth, a.sector_id)) throw fieldError('auditId', 'Auditoria inexistente.');
      if (a.status === 'encerrada' || a.status === 'cancelada') throw fieldError('auditId', 'Auditoria encerrada.');
    }
    const row = await db.transaction().execute(async (trx) => {
      const created = await trx.insertInto('nonconformity').values({ institution_id: auth.institutionId, audit_id: b.auditId, sector_id: b.sectorId, origin: b.origin, severity: b.severity, description: b.description, detected_on: b.detectedOn, status: 'aberta', effectiveness: null, data_origin: await institutionOrigin(trx, auth.institutionId), created_by: auth.userId, updated_at: new Date() }).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto('nonconformity_status').values({ nonconformity_id: created.id, from_status: null, to_status: 'aberta', justification: b.justification, decided_by: auth.userId, decided_by_name: auth.displayName, at: new Date() }).execute();
      await audit(trx, actorOf(req), { action: 'create', entity: 'nonconformity', entityId: created.id, after: created, context: { justification: b.justification } });
      return created;
    });
    reply.code(201);
    return { id: row.id };
  });

  app.post<{ Params: { id: string } }>('/quality/nonconformities/:id/status', manage, async (req) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(NcStatusBody, req.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('nonconformity').selectAll().where('id', '=', id).where('institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst();
      if (!before || !inScope(auth, before.sector_id)) throw notFound('Não conformidade');
      if (before.row_version !== b.rowVersion) throw conflict();
      const actions = await trx.selectFrom('action_plan').select('status').where('nonconformity_id', '=', id).execute();
      const effectiveness = b.effectiveness ?? before.effectiveness;
      const problems = checkNcTransition(before.status, b.to, { justification: b.justification, actions, effectiveness });
      if (problems.length) throw new HttpError(400, 'validacao', 'Não é possível concluir esta etapa. Revise os campos indicados.', problems);
      const after = await trx.updateTable('nonconformity').set({ status: b.to, effectiveness, updated_at: new Date(), row_version: before.row_version + 1 }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto('nonconformity_status').values({ nonconformity_id: id, from_status: before.status, to_status: b.to, justification: b.justification, decided_by: auth.userId, decided_by_name: auth.displayName, at: new Date() }).execute();
      await audit(trx, actorOf(req), { action: 'status_change', entity: 'nonconformity', entityId: id, before, after, context: { justification: b.justification } });
      return { ok: true, rowVersion: after.row_version };
    });
  });

  app.post<{ Params: { id: string } }>('/quality/nonconformities/:id/actions', manage, async (req, reply) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(ActionCreate, req.body);
    const row = await db.transaction().execute(async (trx) => {
      const nc = await trx.selectFrom('nonconformity').select(['id', 'sector_id', 'status']).where('id', '=', id).where('institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst();
      if (!nc || !inScope(auth, nc.sector_id)) throw notFound('Não conformidade');
      if (nc.status === 'encerrada' || nc.status === 'cancelada') throw new HttpError(409, 'nc_encerrada', 'Não conformidade encerrada não recebe novas ações.');
      const created = await trx.insertInto('action_plan').values({ nonconformity_id: id, what: b.what, why: b.why, where_text: b.where, who_name: b.who, due_on: b.dueOn, how: b.how, how_much: b.howMuch, status: 'pendente', completed_on: null, updated_at: new Date() }).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'create', entity: 'action_plan', entityId: created.id, after: created });
      return created;
    });
    reply.code(201);
    return { id: row.id };
  });

  app.post<{ Params: { id: string } }>('/quality/actions/:id/status', execute, async (req) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(ActionStatusBody, req.body);
    const today = todayIn(await tzOf(db, auth.institutionId));
    if (b.status === 'concluida' && !b.completedOn) throw fieldError('completedOn', 'Informe a data de conclusão.');
    if (b.completedOn && b.completedOn > today) throw fieldError('completedOn', 'A conclusão não pode estar no futuro.');
    return db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('action_plan').innerJoin('nonconformity as n', 'n.id', 'action_plan.nonconformity_id').selectAll('action_plan').select(['n.sector_id', 'n.institution_id', 'n.status as nc_status']).where('action_plan.id', '=', id).forUpdate().executeTakeFirst();
      if (!before || before.institution_id !== auth.institutionId || !inScope(auth, before.sector_id)) throw notFound('Ação');
      if (before.row_version !== b.rowVersion) throw conflict();
      if (before.nc_status === 'encerrada' || before.nc_status === 'cancelada') throw new HttpError(409, 'nc_encerrada', 'A não conformidade já foi encerrada.');
      const after = await trx.updateTable('action_plan').set({ status: b.status, completed_on: b.status === 'concluida' ? b.completedOn : null, updated_at: new Date(), row_version: before.row_version + 1 }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'update', entity: 'action_plan', entityId: id, before, after, context: { justification: b.justification } });
      return { ok: true, rowVersion: after.row_version };
    });
  });
}
