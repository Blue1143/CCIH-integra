import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql, type Kysely, type Selectable } from 'kysely';
import { z } from 'zod';
import {
  AMENDMENT_KIND_LABEL, CONTRACT_STATUS_LABEL, CONTRACT_TRANSITIONS, addDays, checkAmendment, checkContract, checkDelivery, checkFinancial,
  contractExpiry, contractSituation, daysToEnd, formatDate, planVsDone, serviceFrequency,
  type AmendmentDto, type AmendmentKind, type ContractDetailDto, type ContractServiceDto, type ContractStatus, type ContractSummaryDto, type DeliveryDto, type Paged,
  type ServicePeriod, type ServiceUnit,
} from '@ccih/domain';
import type { DB, ContractServiceTable, ContractTable } from '../db/types';
import { audit } from '../audit/audit';
import { actorOf, requireAuth, requirePermission, type AuthContext } from '../http/auth';
import { HttpError, conflict, notFound, parse } from '../http/errors';
import { IsoDate, OptionalText, PageQuery, RowVersion, Text, Uuid } from '../http/schemas';
import { escapeLike, institutionOrigin } from '../repositories/clinical';
import { NO_ID, event, fieldError, findClient, inScope, institutionToday, problemsError, scopeOf, type Db } from './consulting-clients';

const AREA = z.enum(['ccih', 'cme', 'qualidade', 'seguranca_paciente', 'gestao']);
const KIND = z.enum(['consultoria_continua', 'visita_tecnica', 'diagnostico', 'auditoria', 'treinamento', 'documentacao', 'indicadores', 'reuniao', 'outro']);
const UNIT = z.enum(['visitas', 'horas', 'entregas']);
const PERIOD = z.enum(['mensal', 'bimestral', 'trimestral', 'semestral', 'anual', 'contrato']);
const STATUS = z.enum(['proposta', 'vigente', 'suspenso', 'encerrado', 'recusada']);
const Reason = z.string().trim().min(5, 'Informe o motivo (mínimo 5 caracteres).').max(1000);

const ServiceBody = z.object({
  id: Uuid.nullable(), area: AREA, kind: KIND, description: Text(300), establishmentId: Uuid.nullable(), unit: UNIT, quantity: z.number(), period: PERIOD,
}).strict();
const ContractBody = z.object({
  title: Text(200), startsOn: IsoDate.nullable(), endsOn: IsoDate.nullable(), autoRenew: z.boolean(), renewalNoticeDays: z.number().int(),
  responsibleId: Uuid.nullable(), scopeNotes: OptionalText(4000), services: z.array(ServiceBody).max(50), rowVersion: RowVersion.nullable(),
}).strict();
const StatusBody = z.object({ status: STATUS, on: IsoDate.nullable(), reason: z.string().trim().max(1000).nullable(), rowVersion: RowVersion }).strict();
const AmendmentBody = z.object({
  kinds: z.array(z.enum(['prazo', 'renovacao', 'escopo', 'valor', 'outro'])).min(1).max(5), description: Text(4000), signedOn: IsoDate, effectiveOn: IsoDate,
  newEndsOn: IsoDate.nullable().optional(), autoRenew: z.boolean().optional(),
  addServices: z.array(ServiceBody).max(20), changeServices: z.array(z.object({ id: Uuid, quantity: z.number(), period: PERIOD }).strict()).max(50), endServices: z.array(Uuid).max(50),
  rowVersion: RowVersion,
}).strict();
const DeliveryBody = z.object({ occurredOn: IsoDate.nullable(), quantity: z.number(), description: Text(1000) }).strict();
const VoidBody = z.object({ reason: Reason }).strict();
const FinancialBody = z.object({
  basis: z.enum(['mensal', 'total', 'por_entrega']), amountCents: z.number().int().nullable(), billingDay: z.number().int().nullable(),
  paymentTerms: OptionalText(1000), adjustmentRule: OptionalText(300), notes: OptionalText(2000), rowVersion: RowVersion.nullable(),
}).strict();
const ListQuery = z.object({
  q: z.string().trim().max(80).optional(), clientId: Uuid.optional(), status: STATUS.optional(), expiring: z.enum(['1']).optional(), ...PageQuery,
}).strict();

type ContractRow = Selectable<ContractTable>;
type LineRow = Selectable<ContractServiceTable>;
const CONSULTANT_ROLES = ['consultor', 'gestor_consultoria', 'admin'];

/** The contract, if it exists in the organization and its client is within the person's scope (404 otherwise). */
async function findContract(db: Db, auth: AuthContext, id: string, lock = false): Promise<ContractRow> {
  let q = db.selectFrom('contract').selectAll().where('id', '=', id).where('institution_id', '=', auth.institutionId);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row || !inScope(auth, row.client_id)) throw notFound('Contrato');
  return row;
}

/** Last day a line counts for planned × done: its own end, the contract's end or the day it was closed. */
function lineEnd(line: { ends_on: string | null }, c: { ends_on: string | null; closed_on: string | null }): string | null {
  const ends = [line.ends_on, c.ends_on, c.closed_on].filter((d): d is string => !!d);
  return ends.length ? ends.sort()[0]! : null;
}

async function linesAndDeliveries(db: Db, contractIds: string[]) {
  if (!contractIds.length) return { lines: [] as LineRow[], deliveries: [] as Array<{ service_id: string; occurred_on: string; quantity: string }> };
  const lines = await db.selectFrom('contract_service').selectAll().where('contract_id', 'in', contractIds).orderBy('position').orderBy('created_at').execute();
  const deliveries = lines.length
    ? await db.selectFrom('contract_delivery').select(['service_id', 'occurred_on', 'quantity']).where('service_id', 'in', lines.map((l) => l.id)).where('voided_at', 'is', null).execute()
    : [];
  return { lines, deliveries };
}

function planOf(line: LineRow, c: ContractRow, deliveries: Array<{ service_id: string; occurred_on: string; quantity: string }>, today: string) {
  if (!line.starts_on || c.status === 'proposta' || c.status === 'recusada') return null;
  return planVsDone(
    { quantity: Number(line.quantity), period: line.period as ServicePeriod, startsOn: line.starts_on, endsOn: lineEnd(line, c) },
    deliveries.filter((d) => d.service_id === line.id).map((d) => ({ occurredOn: d.occurred_on, quantity: Number(d.quantity) })),
    today,
  );
}

async function summaries(db: Db, rows: ContractRow[], today: string): Promise<ContractSummaryDto[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [clients, amendments, people, { lines, deliveries }] = await Promise.all([
    db.selectFrom('client').select(['id', 'legal_name', 'trade_name']).where('id', 'in', rows.map((r) => r.client_id)).execute(),
    db.selectFrom('contract_amendment').select((eb) => ['contract_id', eb.fn.countAll<string>().as('n')]).where('contract_id', 'in', ids).groupBy('contract_id').execute(),
    db.selectFrom('app_user').select(['id', 'display_name']).where('id', 'in', rows.map((r) => r.responsible_id ?? NO_ID)).execute(),
    linesAndDeliveries(db, ids),
  ]);
  const clientName = new Map(clients.map((c) => [c.id, c.trade_name ?? c.legal_name]));
  const amendCount = new Map(amendments.map((a) => [a.contract_id, Number(a.n)]));
  const person = new Map(people.map((p) => [p.id, p.display_name]));
  return rows.map((c) => {
    const own = lines.filter((l) => l.contract_id === c.id);
    let plannedClosed = 0;
    let doneClosed = 0;
    for (const l of own) {
      const p = planOf(l, c, deliveries, today);
      if (p) { plannedClosed += p.plannedClosed; doneClosed += p.doneClosed; }
    }
    return {
      id: c.id, code: c.code, title: c.title, clientId: c.client_id, clientName: clientName.get(c.client_id) ?? '—', status: c.status,
      situation: contractSituation({ status: c.status, endsOn: c.ends_on }, today), startsOn: c.starts_on, endsOn: c.ends_on, autoRenew: c.auto_renew,
      renewalNoticeDays: c.renewal_notice_days, expiry: contractExpiry({ status: c.status, endsOn: c.ends_on, renewalNoticeDays: c.renewal_notice_days }, today),
      daysToEnd: c.status === 'vigente' || c.status === 'suspenso' ? daysToEnd(c.ends_on, today) : null,
      services: own.filter((l) => !l.ends_on || c.status === 'proposta').length, amendments: amendCount.get(c.id) ?? 0, responsible: c.responsible_id ? (person.get(c.responsible_id) ?? null) : null,
      plannedClosed: Math.round(plannedClosed * 100) / 100, doneClosed: Math.round(doneClosed * 100) / 100, dataOrigin: c.data_origin,
    };
  });
}

async function detail(db: Db, auth: AuthContext, c: ContractRow): Promise<ContractDetailDto> {
  const today = await institutionToday(db, auth.institutionId);
  const [summary] = await summaries(db, [c], today);
  const { lines } = await linesAndDeliveries(db, [c.id]);
  const [establishments, allDeliveries, amendments, history, financial] = await Promise.all([
    db.selectFrom('client_establishment').select(['id', 'name']).where('client_id', '=', c.client_id).where('institution_id', '=', auth.institutionId).orderBy('name').execute(),
    lines.length ? db.selectFrom('contract_delivery').selectAll().where('service_id', 'in', lines.map((l) => l.id)).orderBy('occurred_on', 'desc').orderBy('created_at', 'desc').execute() : Promise.resolve([]),
    db.selectFrom('contract_amendment').selectAll().where('contract_id', '=', c.id).orderBy('number', 'desc').execute(),
    db.selectFrom('client_event').selectAll().where('contract_id', '=', c.id).where('institution_id', '=', auth.institutionId).orderBy('occurred_on', 'desc').orderBy('created_at', 'desc').execute(),
    auth.permissions.includes('consultoria:contracts:financial') ? db.selectFrom('contract_financial').selectAll().where('contract_id', '=', c.id).executeTakeFirst() : Promise.resolve(undefined),
  ]);
  const active = allDeliveries.filter((d) => !d.voided_at).map((d) => ({ service_id: d.service_id, occurred_on: d.occurred_on, quantity: d.quantity }));
  const estName = new Map(establishments.map((e) => [e.id, e.name]));
  const serviceLines = lines.map((l): ContractServiceDto => ({
    id: l.id, area: l.area as never, kind: l.kind as never, description: l.description, establishmentId: l.establishment_id, establishmentName: l.establishment_id ? (estName.get(l.establishment_id) ?? null) : null,
    unit: l.unit, quantity: Number(l.quantity), period: l.period as ServicePeriod, startsOn: l.starts_on, endsOn: l.ends_on, replacesId: l.replaces_id, amendmentId: l.amendment_id,
    plan: planOf(l, c, active, today),
  }));
  return {
    ...summary!,
    scopeNotes: c.scope_notes, signedOn: c.signed_on, closedOn: c.closed_on, closeReason: c.close_reason, responsibleId: c.responsible_id,
    rowVersion: c.row_version, createdAt: c.created_at.toISOString(), updatedAt: c.updated_at.toISOString(),
    serviceLines,
    deliveries: allDeliveries.slice(0, 300).map((d): DeliveryDto => ({
      id: d.id, serviceId: d.service_id, occurredOn: d.occurred_on, quantity: Number(d.quantity), description: d.description, by: d.created_by_name, at: d.created_at.toISOString(),
      voidedAt: d.voided_at?.toISOString() ?? null, voidedBy: d.voided_by_name, voidReason: d.void_reason,
    })),
    amendmentList: amendments.map((a): AmendmentDto => ({
      id: a.id, number: a.number, kinds: a.kinds as AmendmentKind[], description: a.description, signedOn: a.signed_on, effectiveOn: a.effective_on, changes: a.changes, by: a.created_by_name, at: a.created_at.toISOString(),
    })),
    history: history.map((h) => ({ id: h.id, summary: h.summary, detail: h.detail, occurredOn: h.occurred_on, by: h.actor_name, at: h.created_at.toISOString() })),
    ...(auth.permissions.includes('consultoria:contracts:financial')
      ? {
        financial: financial
          ? {
            basis: financial.basis, amountCents: financial.amount_cents == null ? null : Number(financial.amount_cents), billingDay: financial.billing_day, paymentTerms: financial.payment_terms,
            adjustmentRule: financial.adjustment_rule, notes: financial.notes, updatedAt: financial.updated_at.toISOString(), updatedBy: financial.updated_by_name, rowVersion: financial.row_version,
          }
          : null,
      }
      : {}),
    establishments,
  };
}

/** A consultant, manager or administrator of the consultancy, with an active account. */
async function checkResponsible(db: Db, auth: AuthContext, userId: string) {
  const user = await db.selectFrom('app_user').select(['id', 'status']).where('id', '=', userId).where('institution_id', '=', auth.institutionId).executeTakeFirst();
  if (!user) throw fieldError('responsibleId', 'Profissional inexistente.');
  if (user.status !== 'ativo') throw fieldError('responsibleId', 'A conta deste profissional não está ativa.');
  const roles = (await db.selectFrom('user_role').select('role_code').where('user_id', '=', user.id).execute()).map((r) => r.role_code);
  if (!roles.some((r) => CONSULTANT_ROLES.includes(r))) throw fieldError('responsibleId', 'O responsável pelo contrato deve ser consultor, gestor ou administrador da consultoria.');
}

/** Establishments named in service lines must belong to the contract's client. */
async function checkEstablishments(db: Db, auth: AuthContext, clientId: string, services: Array<{ establishmentId: string | null }>, path: string) {
  const ids = [...new Set(services.map((s) => s.establishmentId).filter((x): x is string => !!x))];
  if (!ids.length) return;
  const found = await db.selectFrom('client_establishment').select('id').where('id', 'in', ids).where('client_id', '=', clientId).where('institution_id', '=', auth.institutionId).execute();
  if (found.length !== ids.length) throw fieldError(path, 'Estabelecimento não pertence a este cliente.');
}

const serviceValues = (s: z.infer<typeof ServiceBody>) => ({ area: s.area, kind: s.kind, description: s.description, establishment_id: s.establishmentId, unit: s.unit, quantity: s.quantity, period: s.period });
const lineLabel = (l: { description: string; quantity: number | string; unit: string; period: string }) =>
  `${l.description} (${serviceFrequency({ quantity: Number(l.quantity), unit: l.unit as ServiceUnit, period: l.period as ServicePeriod })})`;

export async function consultingContractRoutes(app: FastifyInstance, { db }: { db: Kysely<DB> }) {
  const view = { preHandler: requirePermission(db, 'consultoria:contracts:view') };
  const edit = { preHandler: requirePermission(db, 'consultoria:contracts:edit') };
  const deliver = { preHandler: requirePermission(db, 'consultoria:contracts:deliveries') };
  const financial = { preHandler: requirePermission(db, 'consultoria:contracts:financial') };

  app.get('/consulting/contracts', view, async (req): Promise<Paged<ContractSummaryDto>> => {
    const auth = requireAuth(req);
    const q = parse(ListQuery, req.query);
    const today = await institutionToday(db, auth.institutionId);
    let list = db.selectFrom('contract as k').innerJoin('client as c', 'c.id', 'k.client_id').where('k.institution_id', '=', auth.institutionId);
    const scope = scopeOf(auth);
    if (scope) list = list.where('k.client_id', 'in', scope.length ? scope : [NO_ID]);
    if (q.clientId) list = list.where('k.client_id', '=', q.clientId);
    if (q.status) list = list.where('k.status', '=', q.status);
    // Signed and open, ending within the notice window or already past the end.
    if (q.expiring) list = list.where('k.status', 'in', ['vigente', 'suspenso']).where('k.ends_on', 'is not', null).where(sql<boolean>`k.ends_on <= ${today}::date + k.renewal_notice_days`);
    if (q.q) {
      const t = `%${escapeLike(q.q)}%`;
      list = list.where((eb) => eb.or([eb('k.code', 'ilike', t), eb('k.title', 'ilike', t), eb('c.legal_name', 'ilike', t), eb('c.trade_name', 'ilike', t)]));
    }
    const [rows, total] = await Promise.all([
      list.selectAll('k').orderBy(sql`CASE WHEN k.status IN ('vigente', 'suspenso') THEN 0 WHEN k.status = 'proposta' THEN 1 ELSE 2 END`).orderBy(sql`k.ends_on NULLS LAST`).orderBy('k.code')
        .limit(q.pageSize).offset((q.page - 1) * q.pageSize).execute(),
      list.select((e) => e.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { rows: await summaries(db, rows, today), total: Number(total.n), page: q.page, pageSize: q.pageSize };
  });

  app.get<{ Params: { id: string } }>('/consulting/contracts/:id', view, async (req) => {
    const auth = requireAuth(req);
    return detail(db, auth, await findContract(db, auth, parse(Uuid, req.params.id)));
  });

  /* ---------- Proposals ---------- */

  const saveProposal = async (req: FastifyRequest, clientId: string | null, contractId: string | null) => {
    const auth = requireAuth(req);
    const b = parse(ContractBody, req.body);
    const problems = checkContract(b);
    if (problems.length) throw problemsError(problems);
    const origin = await institutionOrigin(db, auth.institutionId);
    const today = await institutionToday(db, auth.institutionId);
    return db.transaction().execute(async (trx) => {
      const before = contractId ? await findContract(trx, auth, contractId, true) : null;
      if (before && before.row_version !== b.rowVersion) throw conflict();
      if (before && before.status !== 'proposta') throw new HttpError(409, 'contrato_assinado', 'Contrato assinado não é editado diretamente: registre um aditivo.');
      const client = await findClient(trx, auth, before?.client_id ?? clientId!);
      if (!before && client.status === 'encerrado') throw fieldError('title', 'O relacionamento com este cliente está encerrado.');
      if (b.responsibleId) await checkResponsible(trx, auth, b.responsibleId);
      await checkEstablishments(trx, auth, client.id, b.services, 'services');
      const values = {
        title: b.title, starts_on: b.startsOn, ends_on: b.endsOn, auto_renew: b.autoRenew, renewal_notice_days: b.renewalNoticeDays, responsible_id: b.responsibleId,
        scope_notes: b.scopeNotes, updated_at: new Date(),
      };
      let after: ContractRow;
      if (before) {
        after = await trx.updateTable('contract').set({ ...values, row_version: before.row_version + 1 }).where('id', '=', before.id).returningAll().executeTakeFirstOrThrow();
      } else {
        // Sequential code per organization and year, serialized per organization.
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`contract-code:${auth.institutionId}`}))`.execute(trx);
        const prefix = `CT-${today.slice(0, 4)}-`;
        const last = await trx.selectFrom('contract').select('code').where('institution_id', '=', auth.institutionId).where('code', 'like', `${prefix}%`).orderBy('code', 'desc').executeTakeFirst();
        const code = `${prefix}${String((last ? Number(last.code.slice(prefix.length)) : 0) + 1).padStart(3, '0')}`;
        after = await trx.insertInto('contract').values({
          ...values, institution_id: auth.institutionId, client_id: client.id, code, status: 'proposta', created_by: auth.userId, created_by_name: auth.displayName, data_origin: origin,
        }).returningAll().executeTakeFirstOrThrow();
      }
      // Lines of a proposal: kept, updated, added or removed (a proposal is a draft).
      const existing = before ? await trx.selectFrom('contract_service').selectAll().where('contract_id', '=', before.id).execute() : [];
      const keep = new Set(b.services.map((s) => s.id).filter(Boolean));
      if (b.services.some((s) => s.id && !existing.some((e) => e.id === s.id))) throw fieldError('services', 'Serviço inexistente nesta proposta.');
      const removed = existing.filter((e) => !keep.has(e.id));
      if (removed.length) await trx.deleteFrom('contract_service').where('id', 'in', removed.map((r) => r.id)).execute();
      for (const [i, s] of b.services.entries()) {
        if (s.id) await trx.updateTable('contract_service').set({ ...serviceValues(s), position: i }).where('id', '=', s.id).execute();
        else await trx.insertInto('contract_service').values({ ...serviceValues(s), position: i, institution_id: auth.institutionId, contract_id: after.id }).execute();
      }
      await audit(trx, actorOf(req), {
        action: before ? 'update' : 'create', entity: 'contract', entityId: after.id, before: before ? { ...before, services: existing } : null,
        after: { ...after, services: b.services }, context: removed.length ? { removedServices: removed.map(lineLabel) } : undefined,
      });
      if (!before) await event(trx, auth, client.id, 'contrato', `Proposta ${after.code} cadastrada: ${after.title}.`, null, today, after.id);
      return detail(trx, auth, after);
    });
  };
  app.post<{ Params: { id: string } }>('/consulting/clients/:id/contracts', edit, async (req, reply) => {
    const r = await saveProposal(req, parse(Uuid, req.params.id), null);
    reply.code(201);
    return r;
  });
  app.put<{ Params: { id: string } }>('/consulting/contracts/:id', edit, async (req) => saveProposal(req, null, parse(Uuid, req.params.id)));

  /* ---------- Status: signature, refusal, suspension, resumption, termination ---------- */

  app.post<{ Params: { id: string } }>('/consulting/contracts/:id/status', edit, async (req) => {
    const auth = requireAuth(req);
    const b = parse(StatusBody, req.body);
    const today = await institutionToday(db, auth.institutionId);
    const on = b.on ?? today;
    if (on > today) throw fieldError('on', 'A data não pode estar no futuro.');
    return db.transaction().execute(async (trx) => {
      const c = await findContract(trx, auth, parse(Uuid, req.params.id), true);
      if (c.row_version !== b.rowVersion) throw conflict();
      if (!CONTRACT_TRANSITIONS[c.status].includes(b.status)) {
        throw new HttpError(409, 'transicao_invalida', `Não é possível passar de "${CONTRACT_STATUS_LABEL[c.status]}" para "${CONTRACT_STATUS_LABEL[b.status as ContractStatus]}".`);
      }
      const reason = b.reason?.trim() || null;
      const signing = c.status === 'proposta' && b.status === 'vigente';
      if (!signing && (!reason || reason.length < 5)) throw fieldError('reason', 'Informe o motivo (mínimo 5 caracteres).');
      const set: Partial<{ status: ContractStatus; signed_on: string; closed_on: string; close_reason: string }> = { status: b.status };
      if (signing) {
        const lines = await trx.selectFrom('contract_service').selectAll().where('contract_id', '=', c.id).execute();
        const problems = checkContract({
          title: c.title, startsOn: c.starts_on, endsOn: c.ends_on, autoRenew: c.auto_renew, renewalNoticeDays: c.renewal_notice_days, responsibleId: c.responsible_id, scopeNotes: c.scope_notes,
          services: lines.map((l) => ({ id: l.id, area: l.area as never, kind: l.kind as never, description: l.description, establishmentId: l.establishment_id, unit: l.unit, quantity: Number(l.quantity), period: l.period as ServicePeriod })),
        }, { signing: true });
        if (problems.length) throw problemsError(problems);
        // Lines start with the contract (still a proposal at this point, so the lines can be completed).
        await trx.updateTable('contract_service').set({ starts_on: c.starts_on }).where('contract_id', '=', c.id).where('starts_on', 'is', null).execute();
        set.signed_on = on;
      }
      if (b.status === 'encerrado' || b.status === 'recusada') {
        if (b.status === 'encerrado' && c.starts_on && on < c.starts_on) throw fieldError('on', 'O encerramento não pode ser anterior ao início.');
        set.closed_on = on;
        set.close_reason = reason!;
      }
      const after = await trx.updateTable('contract').set({ ...set, updated_at: new Date(), row_version: c.row_version + 1 }).where('id', '=', c.id).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'update', entity: 'contract', entityId: c.id, before: { status: c.status }, after: { status: after.status, on }, context: reason ? { justification: reason } : undefined });
      const verb: Record<string, string> = {
        'proposta>vigente': `Contrato ${c.code} assinado em ${formatDate(on)}; vigência a partir de ${formatDate(c.starts_on!)}${c.ends_on ? ` até ${formatDate(c.ends_on)}` : ', sem término definido'}.`,
        'proposta>recusada': `Proposta ${c.code} recusada.`, 'vigente>suspenso': `Contrato ${c.code} suspenso.`, 'suspenso>vigente': `Contrato ${c.code} retomado.`,
        'vigente>encerrado': `Contrato ${c.code} encerrado em ${formatDate(on)}.`, 'suspenso>encerrado': `Contrato ${c.code} encerrado em ${formatDate(on)}.`,
      };
      await event(trx, auth, c.client_id, 'contrato', verb[`${c.status}>${b.status}`] ?? `Contrato ${c.code}: ${CONTRACT_STATUS_LABEL[b.status as ContractStatus]}.`, reason, on, c.id);
      // A signed contract turns a prospect into an active client.
      if (signing) {
        const client = await trx.selectFrom('client').select(['id', 'status', 'row_version']).where('id', '=', c.client_id).forUpdate().executeTakeFirstOrThrow();
        if (client.status === 'prospecto') {
          await trx.updateTable('client').set({ status: 'ativo', updated_at: new Date(), row_version: client.row_version + 1 }).where('id', '=', client.id).execute();
          await audit(trx, actorOf(req), { action: 'update', entity: 'client', entityId: client.id, before: { status: 'prospecto' }, after: { status: 'ativo' }, context: { contract: c.code } });
          await event(trx, auth, client.id, 'alteracao', 'Situação: prospecto → ativo.', `Contrato ${c.code} assinado.`, on);
        }
      }
      return detail(trx, auth, after);
    });
  });

  /* ---------- Amendments ---------- */

  app.post<{ Params: { id: string } }>('/consulting/contracts/:id/amendments', edit, async (req, reply) => {
    const auth = requireAuth(req);
    const b = parse(AmendmentBody, req.body);
    const today = await institutionToday(db, auth.institutionId);
    if (b.signedOn > today) throw fieldError('signedOn', 'A assinatura não pode estar no futuro.');
    return db.transaction().execute(async (trx) => {
      const c = await findContract(trx, auth, parse(Uuid, req.params.id), true);
      if (c.row_version !== b.rowVersion) throw conflict();
      if (c.status !== 'vigente' && c.status !== 'suspenso') throw new HttpError(409, 'contrato_nao_vigente', 'Aditivos só se aplicam a contratos assinados e não encerrados.');
      const problems = checkAmendment(b, { startsOn: c.starts_on, endsOn: c.ends_on });
      if (problems.length) throw problemsError(problems);
      if (b.signedOn < c.signed_on!) throw fieldError('signedOn', 'O aditivo não pode ser assinado antes do contrato.');
      await checkEstablishments(trx, auth, c.client_id, b.addServices, 'addServices');
      const lines = await trx.selectFrom('contract_service').selectAll().where('contract_id', '=', c.id).execute();
      const touched = [...b.changeServices.map((s) => s.id), ...b.endServices];
      for (const id of touched) {
        const l = lines.find((x) => x.id === id);
        if (!l) throw fieldError('changeServices', 'Serviço inexistente neste contrato.');
        if (l.ends_on) throw fieldError('changeServices', `O serviço "${l.description}" já foi encerrado.`);
        if (b.effectiveOn <= l.starts_on!) throw fieldError('effectiveOn', `O efeito deve ser posterior ao início do serviço "${l.description}" (${formatDate(l.starts_on!)}).`);
      }
      const last = await trx.selectFrom('contract_amendment').select((eb) => eb.fn.max('number').as('n')).where('contract_id', '=', c.id).executeTakeFirst();
      const number = Number(last?.n ?? 0) + 1;
      const endOfOld = addDays(b.effectiveOn, -1);
      const changes: string[] = [];
      if (b.newEndsOn !== undefined && b.newEndsOn !== c.ends_on) changes.push(`Término: ${c.ends_on ? formatDate(c.ends_on) : 'sem término'} → ${b.newEndsOn ? formatDate(b.newEndsOn) : 'sem término'}.`);
      if (b.autoRenew !== undefined && b.autoRenew !== c.auto_renew) changes.push(`Renovação automática: ${c.auto_renew ? 'sim' : 'não'} → ${b.autoRenew ? 'sim' : 'não'}.`);
      for (const s of b.addServices) changes.push(`Serviço incluído: ${lineLabel(s)}, a partir de ${formatDate(b.effectiveOn)}.`);
      for (const s of b.changeServices) {
        const l = lines.find((x) => x.id === s.id)!;
        changes.push(`Serviço alterado: ${lineLabel(l)} → ${serviceFrequency({ quantity: s.quantity, unit: l.unit, period: s.period })}, a partir de ${formatDate(b.effectiveOn)}.`);
      }
      for (const id of b.endServices) changes.push(`Serviço encerrado: ${lineLabel(lines.find((x) => x.id === id)!)}, último dia ${formatDate(endOfOld)}.`);
      const before = { endsOn: c.ends_on, autoRenew: c.auto_renew, services: lines.filter((l) => !l.ends_on).map((l) => ({ id: l.id, line: lineLabel(l) })) };
      const amendment = await trx.insertInto('contract_amendment').values({
        institution_id: auth.institutionId, contract_id: c.id, number, kinds: b.kinds, description: b.description, signed_on: b.signedOn, effective_on: b.effectiveOn,
        changes, snapshot: JSON.stringify({ before }), created_by: auth.userId, created_by_name: auth.displayName,
      }).returningAll().executeTakeFirstOrThrow();
      const position = lines.length;
      for (const [i, s] of b.addServices.entries()) {
        await trx.insertInto('contract_service').values({ ...serviceValues(s), institution_id: auth.institutionId, contract_id: c.id, starts_on: b.effectiveOn, amendment_id: amendment.id, position: position + i }).execute();
      }
      for (const [i, s] of b.changeServices.entries()) {
        const l = lines.find((x) => x.id === s.id)!;
        await trx.updateTable('contract_service').set({ ends_on: endOfOld }).where('id', '=', l.id).execute();
        await trx.insertInto('contract_service').values({
          area: l.area, kind: l.kind, description: l.description, establishment_id: l.establishment_id, unit: l.unit, quantity: s.quantity, period: s.period,
          institution_id: auth.institutionId, contract_id: c.id, starts_on: b.effectiveOn, replaces_id: l.id, amendment_id: amendment.id, position: position + b.addServices.length + i,
        }).execute();
      }
      if (b.endServices.length) await trx.updateTable('contract_service').set({ ends_on: endOfOld }).where('id', 'in', b.endServices).execute();
      const after = await trx.updateTable('contract').set({
        ...(b.newEndsOn !== undefined ? { ends_on: b.newEndsOn } : {}), ...(b.autoRenew !== undefined ? { auto_renew: b.autoRenew } : {}), updated_at: new Date(), row_version: c.row_version + 1,
      }).where('id', '=', c.id).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'create', entity: 'contract_amendment', entityId: amendment.id, before, after: { number, kinds: b.kinds, changes, endsOn: after.ends_on }, context: { contract: c.code } });
      await event(trx, auth, c.client_id, 'contrato', `Aditivo nº ${number} ao contrato ${c.code} (${b.kinds.map((k) => AMENDMENT_KIND_LABEL[k]).join(', ')}).`, changes.join(' ') || b.description, b.signedOn, c.id);
      reply.code(201);
      return detail(trx, auth, after);
    });
  });

  /* ---------- Deliveries (planned × done) ---------- */

  app.post<{ Params: { id: string } }>('/consulting/contract-services/:id/deliveries', deliver, async (req, reply) => {
    const auth = requireAuth(req);
    const b = parse(DeliveryBody, req.body);
    const today = await institutionToday(db, auth.institutionId);
    return db.transaction().execute(async (trx) => {
      const line = await trx.selectFrom('contract_service').selectAll().where('id', '=', parse(Uuid, req.params.id)).where('institution_id', '=', auth.institutionId).executeTakeFirst();
      if (!line) throw notFound('Serviço');
      const c = await findContract(trx, auth, line.contract_id);
      if (c.status === 'proposta' || c.status === 'recusada' || !line.starts_on) throw new HttpError(409, 'contrato_nao_assinado', 'Entregas são registradas a partir da assinatura do contrato.');
      const problems = checkDelivery({ serviceId: line.id, occurredOn: b.occurredOn, quantity: b.quantity, description: b.description }, line.unit);
      if (problems.length) throw problemsError(problems);
      const occurredOn = b.occurredOn ?? today;
      if (occurredOn > today) throw fieldError('occurredOn', 'A data da entrega não pode estar no futuro.');
      const end = lineEnd(line, c);
      if (occurredOn < line.starts_on || (end && occurredOn > end)) {
        throw fieldError('occurredOn', `Fora da vigência do serviço (${formatDate(line.starts_on)}${end ? ` a ${formatDate(end)}` : ' em diante'}).`);
      }
      const row = await trx.insertInto('contract_delivery').values({
        institution_id: auth.institutionId, service_id: line.id, occurred_on: occurredOn, quantity: b.quantity, description: b.description, created_by: auth.userId, created_by_name: auth.displayName,
      }).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'create', entity: 'contract_delivery', entityId: row.id, after: row, context: { contract: c.code } });
      reply.code(201);
      return detail(trx, auth, c);
    });
  });

  app.post<{ Params: { id: string } }>('/consulting/contract-deliveries/:id/void', deliver, async (req) => {
    const auth = requireAuth(req);
    const b = parse(VoidBody, req.body);
    return db.transaction().execute(async (trx) => {
      const d = await trx.selectFrom('contract_delivery as d').innerJoin('contract_service as s', 's.id', 'd.service_id').selectAll('d').select('s.contract_id')
        .where('d.id', '=', parse(Uuid, req.params.id)).where('d.institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst();
      if (!d) throw notFound('Entrega');
      const c = await findContract(trx, auth, d.contract_id);
      if (d.voided_at) throw new HttpError(409, 'ja_anulada', 'Esta entrega já foi anulada.');
      await trx.updateTable('contract_delivery').set({ voided_at: new Date(), voided_by_name: auth.displayName, void_reason: b.reason }).where('id', '=', d.id).execute();
      await audit(trx, actorOf(req), { action: 'update', entity: 'contract_delivery', entityId: d.id, before: { voided: false }, after: { voided: true }, context: { justification: b.reason, contract: c.code } });
      return detail(trx, auth, c);
    });
  });

  /* ---------- Financial terms (restricted) ---------- */

  app.put<{ Params: { id: string } }>('/consulting/contracts/:id/financial', financial, async (req) => {
    const auth = requireAuth(req);
    const b = parse(FinancialBody, req.body);
    const problems = checkFinancial(b);
    if (problems.length) throw problemsError(problems);
    return db.transaction().execute(async (trx) => {
      const c = await findContract(trx, auth, parse(Uuid, req.params.id), true);
      if (c.status === 'recusada') throw new HttpError(409, 'proposta_recusada', 'Proposta recusada não recebe condições financeiras.');
      const before = await trx.selectFrom('contract_financial').selectAll().where('contract_id', '=', c.id).forUpdate().executeTakeFirst();
      if ((before?.row_version ?? null) !== b.rowVersion) throw conflict();
      const values = {
        basis: b.basis, amount_cents: b.amountCents, billing_day: b.billingDay, payment_terms: b.paymentTerms, adjustment_rule: b.adjustmentRule, notes: b.notes,
        updated_at: new Date(), updated_by_name: auth.displayName,
      };
      const after = before
        ? await trx.updateTable('contract_financial').set({ ...values, row_version: before.row_version + 1 }).where('contract_id', '=', c.id).returningAll().executeTakeFirstOrThrow()
        : await trx.insertInto('contract_financial').values({ ...values, contract_id: c.id, institution_id: auth.institutionId }).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: before ? 'update' : 'create', entity: 'contract_financial', entityId: c.id, before: before ?? null, after, context: { contract: c.code } });
      return detail(trx, auth, c);
    });
  });
}
