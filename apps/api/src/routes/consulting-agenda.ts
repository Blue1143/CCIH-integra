import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql, type Kysely, type Selectable } from 'kysely';
import { z } from 'zod';
import {
  ACTIVITY_KIND_LABEL, ACTIVITY_STATUS_LABEL, activitySituation, agendaIcs, checkActivity, checkOutcome, checkTask, dateInZone, deliveredQuantity, formatDate,
  scheduleConflicts, serviceFrequency, todayIn,
  type ActivityDetailDto, type ActivityEventKind, type ActivityKind, type ActivityOptionsDto, type ActivitySummaryDto, type Busy, type Paged, type ServicePeriod, type TaskDto,
} from '@ccih/domain';
import type { DB, ConsultingActivityTable, ConsultingTaskTable } from '../db/types';
import { audit } from '../audit/audit';
import { actorOf, requireAuth, requirePermission, type AuthContext } from '../http/auth';
import { HttpError, conflict, notFound, parse } from '../http/errors';
import { IsoDate, Instant, OptionalText, PageQuery, RowVersion, Text, Uuid } from '../http/schemas';
import { institutionOrigin } from '../repositories/clinical';
import { NO_ID, event as clientEvent, fieldError, findClient, inScope, problemsError, scopeOf, type Db } from './consulting-clients';

const KIND = z.enum(['visita_tecnica', 'reuniao', 'auditoria', 'inspecao', 'treinamento', 'entrega', 'diagnostico', 'outro']);
const ActivityBody = z.object({
  kind: KIND, mode: z.enum(['presencial', 'remoto']), title: Text(200), description: OptionalText(4000), startsAt: z.string().max(40), endsAt: z.string().max(40),
  location: OptionalText(300), establishmentId: Uuid.nullable(), contractServiceId: Uuid.nullable(), responsibleId: Uuid, participantIds: z.array(Uuid).max(20),
  /** Schedule even if someone already has another activity at that time (the conflict is shown first). */
  allowOverlap: z.boolean().default(false), reason: z.string().trim().max(500).nullable().default(null), rowVersion: RowVersion.nullable(),
}).strict();
const TaskBody = z.object({ description: Text(500), ownerId: Uuid, dueOn: IsoDate }).strict();
const OutcomeBody = z.object({
  status: z.enum(['realizada', 'nao_realizada', 'cancelada']), summary: OptionalText(1000), detail: OptionalText(8000), actualMinutes: z.number().int().nullable(),
  reason: OptionalText(1000), registerDelivery: z.boolean(), tasks: z.array(TaskBody).max(20), rowVersion: RowVersion,
}).strict();
const CloseTaskBody = z.object({ status: z.enum(['concluida', 'cancelada']), note: z.string().trim().min(3, 'Descreva o que foi feito (mínimo 3 caracteres).').max(1000), rowVersion: RowVersion }).strict();
const ListQuery = z.object({
  from: Instant.optional(), to: Instant.optional(), clientId: Uuid.optional(), userId: Uuid.optional(), mine: z.enum(['1']).optional(),
  status: z.enum(['agendada', 'realizada', 'nao_realizada', 'cancelada', 'sem_registro']).optional(), kind: KIND.optional(), ...PageQuery,
}).strict();
const TaskQuery = z.object({ mine: z.enum(['1']).optional(), status: z.enum(['aberta', 'concluida', 'cancelada', 'atrasada']).optional(), clientId: Uuid.optional(), ...PageQuery }).strict();
const IcsQuery = z.object({ from: IsoDate.optional(), to: IsoDate.optional(), mine: z.enum(['1']).optional() }).strict();

type ActivityRow = Selectable<ConsultingActivityTable>;
type TaskRow = Selectable<ConsultingTaskTable>;
const ACTIVE_STATUSES = ['agendada'] as const;

async function timezoneOf(db: Db, institutionId: string) {
  return (await db.selectFrom('institution').select('timezone').where('id', '=', institutionId).executeTakeFirstOrThrow()).timezone;
}

/** The activity, if it exists in the organization and its client is within the person's scope (404 otherwise). */
async function findActivity(db: Db, auth: AuthContext, id: string, lock = false): Promise<ActivityRow> {
  let q = db.selectFrom('consulting_activity').selectAll().where('id', '=', id).where('institution_id', '=', auth.institutionId);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row || !inScope(auth, row.client_id)) throw notFound('Atividade');
  return row;
}

/**
 * People of the consultancy who may take part in an activity of the client: active accounts whose
 * profiles (and valid individual grants) see the agenda and either the whole portfolio or this client.
 */
async function eligiblePeople(db: Db, institutionId: string, clientId: string, today: string): Promise<Array<{ userId: string; name: string }>> {
  const users = await db.selectFrom('app_user').select(['id', 'display_name']).where('institution_id', '=', institutionId).where('status', '=', 'ativo').where('active', '=', true).orderBy('display_name').execute();
  if (!users.length) return [];
  const ids = users.map((u) => u.id);
  const [roles, grants, assigned] = await Promise.all([
    db.selectFrom('user_role').innerJoin('role', (j) => j.onRef('role.code', '=', 'user_role.role_code').onRef('role.institution_id', '=', 'user_role.institution_id'))
      .select(['user_role.user_id', 'role.permissions']).where('user_role.user_id', 'in', ids).execute(),
    db.selectFrom('user_permission').select(['user_id', 'permission']).where('user_id', 'in', ids).where('revoked_at', 'is', null)
      .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>=', today)])).execute(),
    db.selectFrom('client_assignment').select('user_id').where('client_id', '=', clientId).where('starts_on', '<=', today).where((eb) => eb.or([eb('ends_on', 'is', null), eb('ends_on', '>', today)])).execute(),
  ]);
  const perms = (id: string) => new Set([...roles.filter((r) => r.user_id === id).flatMap((r) => r.permissions), ...grants.filter((g) => g.user_id === id).map((g) => g.permission)]);
  const onClient = new Set(assigned.map((a) => a.user_id));
  return users.filter((u) => {
    const p = perms(u.id);
    return p.has('consultoria:agenda:view') && (p.has('consultoria:portfolio:all') || onClient.has(u.id));
  }).map((u) => ({ userId: u.id, name: u.display_name }));
}

/** Contracted service lines in force for the client (signed contracts not closed), for linking an activity. */
async function clientServices(db: Db, institutionId: string, clientId: string) {
  return db.selectFrom('contract_service as s').innerJoin('contract as k', 'k.id', 's.contract_id')
    .select(['s.id', 's.description', 's.unit', 's.quantity', 's.period', 's.starts_on', 's.ends_on', 'k.code', 'k.id as contract_id', 'k.status', 'k.ends_on as contract_ends_on'])
    .where('k.client_id', '=', clientId).where('k.institution_id', '=', institutionId).where('k.status', 'in', ['vigente', 'suspenso']).where('s.starts_on', 'is not', null).execute();
}

async function busyOf(db: Db, institutionId: string, people: string[], startsAt: string, endsAt: string): Promise<Busy[]> {
  if (!people.length) return [];
  const rows = await db.selectFrom('consulting_activity as a').innerJoin('client as c', 'c.id', 'a.client_id')
    .leftJoin('consulting_activity_participant as p', 'p.activity_id', 'a.id')
    .select(['a.id', 'a.title', 'a.starts_at', 'a.ends_at', 'a.responsible_id', 'p.user_id', 'c.legal_name', 'c.trade_name'])
    .where('a.institution_id', '=', institutionId).where('a.status', '=', 'agendada')
    .where('a.starts_at', '<', new Date(endsAt)).where('a.ends_at', '>', new Date(startsAt))
    .where((eb) => eb.or([eb('a.responsible_id', 'in', people), eb('p.user_id', 'in', people)])).execute();
  const out: Busy[] = [];
  for (const r of rows) {
    for (const userId of [r.responsible_id, r.user_id]) {
      if (userId && people.includes(userId)) out.push({ activityId: r.id, userId, startsAt: r.starts_at.toISOString(), endsAt: r.ends_at.toISOString(), title: r.title, clientName: r.trade_name ?? r.legal_name });
    }
  }
  return out;
}

async function activityEvent(trx: Db, auth: AuthContext, activityId: string, kind: ActivityEventKind, summary: string, detail: string | null = null) {
  await trx.insertInto('consulting_activity_event').values({ institution_id: auth.institutionId, activity_id: activityId, kind, summary, detail, actor_id: auth.userId, actor_name: auth.displayName }).execute();
}

async function summaries(db: Db, rows: ActivityRow[], now: Date): Promise<ActivitySummaryDto[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [clients, establishments, people, participants, services, tasks] = await Promise.all([
    db.selectFrom('client').select(['id', 'legal_name', 'trade_name']).where('id', 'in', [...new Set(rows.map((r) => r.client_id))]).execute(),
    db.selectFrom('client_establishment').select(['id', 'name']).where('id', 'in', rows.map((r) => r.establishment_id ?? NO_ID)).execute(),
    db.selectFrom('app_user').select(['id', 'display_name']).where('id', 'in', [...new Set(rows.map((r) => r.responsible_id))]).execute(),
    db.selectFrom('consulting_activity_participant as p').innerJoin('app_user as u', 'u.id', 'p.user_id').select(['p.activity_id', 'u.id', 'u.display_name']).where('p.activity_id', 'in', ids).orderBy('u.display_name').execute(),
    db.selectFrom('contract_service').select(['id', 'description']).where('id', 'in', rows.map((r) => r.contract_service_id ?? NO_ID)).execute(),
    db.selectFrom('consulting_task').select((eb) => ['activity_id', eb.fn.countAll<string>().as('n')]).where('activity_id', 'in', ids).where('status', '=', 'aberta').groupBy('activity_id').execute(),
  ]);
  const clientName = new Map(clients.map((c) => [c.id, c.trade_name ?? c.legal_name]));
  const est = new Map(establishments.map((e) => [e.id, e.name]));
  const person = new Map(people.map((p) => [p.id, p.display_name]));
  const service = new Map(services.map((s) => [s.id, s.description]));
  const open = new Map(tasks.map((t) => [t.activity_id, Number(t.n)]));
  return rows.map((a) => ({
    id: a.id, kind: a.kind as ActivityKind, mode: a.mode, title: a.title, clientId: a.client_id, clientName: clientName.get(a.client_id) ?? '—',
    establishmentName: a.establishment_id ? (est.get(a.establishment_id) ?? null) : null, startsAt: a.starts_at.toISOString(), endsAt: a.ends_at.toISOString(), location: a.location,
    status: a.status, situation: activitySituation({ status: a.status, endsAt: a.ends_at.toISOString() }, now),
    responsible: { userId: a.responsible_id, name: person.get(a.responsible_id) ?? '—' },
    participants: participants.filter((p) => p.activity_id === a.id).map((p) => ({ userId: p.id, name: p.display_name })),
    serviceDescription: a.contract_service_id ? (service.get(a.contract_service_id) ?? null) : null, openTasks: open.get(a.id) ?? 0, dataOrigin: a.data_origin,
  }));
}

async function taskDtos(db: Db, rows: TaskRow[], today: string): Promise<TaskDto[]> {
  if (!rows.length) return [];
  const [clients, owners, activities] = await Promise.all([
    db.selectFrom('client').select(['id', 'legal_name', 'trade_name']).where('id', 'in', [...new Set(rows.map((r) => r.client_id))]).execute(),
    db.selectFrom('app_user').select(['id', 'display_name']).where('id', 'in', [...new Set(rows.map((r) => r.owner_id))]).execute(),
    db.selectFrom('consulting_activity').select(['id', 'title']).where('id', 'in', rows.map((r) => r.activity_id ?? NO_ID)).execute(),
  ]);
  const clientName = new Map(clients.map((c) => [c.id, c.trade_name ?? c.legal_name]));
  const owner = new Map(owners.map((o) => [o.id, o.display_name]));
  const activity = new Map(activities.map((a) => [a.id, a.title]));
  return rows.map((t) => ({
    id: t.id, description: t.description, clientId: t.client_id, clientName: clientName.get(t.client_id) ?? '—', activityId: t.activity_id, activityTitle: t.activity_id ? (activity.get(t.activity_id) ?? null) : null,
    owner: { userId: t.owner_id, name: owner.get(t.owner_id) ?? '—' }, dueOn: t.due_on, status: t.status, late: t.status === 'aberta' && t.due_on < today,
    closedNote: t.closed_note, closedBy: t.closed_by_name, closedAt: t.closed_at?.toISOString() ?? null, createdBy: t.created_by_name, createdAt: t.created_at.toISOString(), rowVersion: t.row_version,
  }));
}

async function detail(db: Db, auth: AuthContext, a: ActivityRow): Promise<ActivityDetailDto> {
  const now = new Date();
  const today = todayIn(await timezoneOf(db, auth.institutionId), now);
  const [summary] = await summaries(db, [a], now);
  const [tasks, events, service, delivery] = await Promise.all([
    db.selectFrom('consulting_task').selectAll().where('activity_id', '=', a.id).orderBy('created_at').execute(),
    db.selectFrom('consulting_activity_event').selectAll().where('activity_id', '=', a.id).orderBy('created_at', 'desc').execute(),
    a.contract_service_id ? db.selectFrom('contract_service as s').innerJoin('contract as k', 'k.id', 's.contract_id').select(['k.id', 'k.code']).where('s.id', '=', a.contract_service_id).executeTakeFirst() : Promise.resolve(undefined),
    db.selectFrom('contract_delivery').select('id').where('activity_id', '=', a.id).executeTakeFirst(),
  ]);
  return {
    ...summary!,
    description: a.description, establishmentId: a.establishment_id, contractServiceId: a.contract_service_id, contractId: service?.id ?? null, contractCode: service?.code ?? null,
    outcomeSummary: a.outcome_summary, outcomeDetail: a.outcome_detail, actualMinutes: a.actual_minutes, closeReason: a.close_reason, recordedBy: a.recorded_by_name,
    recordedAt: a.recorded_at?.toISOString() ?? null, deliveryId: delivery?.id ?? null, tasks: await taskDtos(db, tasks, today),
    events: events.map((e) => ({ id: e.id, kind: e.kind as ActivityEventKind, summary: e.summary, detail: e.detail, by: e.actor_name, at: e.created_at.toISOString() })),
    rowVersion: a.row_version, createdBy: a.created_by_name, createdAt: a.created_at.toISOString(),
  };
}

export async function consultingAgendaRoutes(app: FastifyInstance, { db }: { db: Kysely<DB> }) {
  const view = { preHandler: requirePermission(db, 'consultoria:agenda:view') };
  const edit = { preHandler: requirePermission(db, 'consultoria:agenda:edit') };
  const record = { preHandler: requirePermission(db, 'consultoria:agenda:record') };
  const editOrRecord = { preHandler: requirePermission(db, 'consultoria:agenda:edit', 'consultoria:agenda:record') };

  const listBase = (auth: AuthContext) => {
    let q = db.selectFrom('consulting_activity as a').where('a.institution_id', '=', auth.institutionId);
    const scope = scopeOf(auth);
    if (scope) q = q.where('a.client_id', 'in', scope.length ? scope : [NO_ID]);
    return q;
  };
  const withPerson = <T extends ReturnType<typeof listBase>>(q: T, userId: string) =>
    q.where((eb) => eb.or([eb('a.responsible_id', '=', userId), eb.exists(eb.selectFrom('consulting_activity_participant as p').select('p.user_id').whereRef('p.activity_id', '=', 'a.id').where('p.user_id', '=', userId))])) as T;

  app.get('/consulting/activities', view, async (req): Promise<Paged<ActivitySummaryDto>> => {
    const auth = requireAuth(req);
    const q = parse(ListQuery, req.query);
    const now = new Date();
    let list = listBase(auth);
    if (q.from) list = list.where('a.ends_at', '>', q.from);
    if (q.to) list = list.where('a.starts_at', '<', q.to);
    if (q.clientId) list = list.where('a.client_id', '=', q.clientId);
    if (q.kind) list = list.where('a.kind', '=', q.kind);
    if (q.status === 'sem_registro') list = list.where('a.status', '=', 'agendada').where('a.ends_at', '<', now);
    else if (q.status) list = list.where('a.status', '=', q.status);
    const person = q.mine ? auth.userId : q.userId;
    if (person) list = withPerson(list, person);
    const [rows, total] = await Promise.all([
      list.selectAll('a').orderBy('a.starts_at').orderBy('a.id').limit(q.pageSize).offset((q.page - 1) * q.pageSize).execute(),
      list.select((e) => e.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { rows: await summaries(db, rows, now), total: Number(total.n), page: q.page, pageSize: q.pageSize };
  });

  app.get<{ Params: { id: string } }>('/consulting/activities/:id', view, async (req) => {
    const auth = requireAuth(req);
    return detail(db, auth, await findActivity(db, auth, parse(Uuid, req.params.id)));
  });

  /** What the activity form offers for a client (people who may take part, establishments, contracted services). */
  app.get<{ Params: { id: string } }>('/consulting/clients/:id/activity-options', editOrRecord, async (req): Promise<ActivityOptionsDto> => {
    const auth = requireAuth(req);
    const client = await findClient(db, auth, parse(Uuid, req.params.id));
    const today = todayIn(await timezoneOf(db, auth.institutionId));
    const [establishments, services, people] = await Promise.all([
      db.selectFrom('client_establishment').select(['id', 'name']).where('client_id', '=', client.id).where('active', '=', true).orderBy('name').execute(),
      clientServices(db, auth.institutionId, client.id),
      eligiblePeople(db, auth.institutionId, client.id, today),
    ]);
    return {
      establishments,
      services: services.filter((s) => !s.ends_on || s.ends_on >= today).map((s) => ({
        id: s.id, contractCode: s.code, description: s.description, unit: s.unit, frequency: serviceFrequency({ quantity: Number(s.quantity), unit: s.unit, period: s.period as ServicePeriod }),
      })),
      people,
    };
  });

  const saveActivity = async (req: FastifyRequest, clientId: string | null, activityId: string | null) => {
    const auth = requireAuth(req);
    const b = parse(ActivityBody, req.body);
    const problems = checkActivity(b);
    if (problems.length) throw problemsError(problems);
    const tz = await timezoneOf(db, auth.institutionId);
    const today = todayIn(tz);
    const origin = await institutionOrigin(db, auth.institutionId);
    return db.transaction().execute(async (trx) => {
      const before = activityId ? await findActivity(trx, auth, activityId, true) : null;
      if (before && before.row_version !== b.rowVersion) throw conflict();
      if (before && before.status !== 'agendada') throw new HttpError(409, 'atividade_registrada', `Atividade ${ACTIVITY_STATUS_LABEL[before.status].toLowerCase()}: não é mais alterada.`);
      const client = await findClient(trx, auth, before?.client_id ?? clientId!);
      if (!before && client.status === 'encerrado') throw fieldError('title', 'O relacionamento com este cliente está encerrado.');
      const people = await eligiblePeople(trx, auth.institutionId, client.id, today);
      const allowed = new Set(people.map((p) => p.userId));
      if (!allowed.has(b.responsibleId)) throw fieldError('responsibleId', 'O responsável deve ser da equipe com acesso a este cliente e à agenda.');
      const outsider = b.participantIds.find((p) => !allowed.has(p));
      if (outsider) throw fieldError('participantIds', 'Todos os participantes devem ser da equipe com acesso a este cliente e à agenda.');
      if (b.establishmentId) {
        const est = await trx.selectFrom('client_establishment').select('id').where('id', '=', b.establishmentId).where('client_id', '=', client.id).where('institution_id', '=', auth.institutionId).executeTakeFirst();
        if (!est) throw fieldError('establishmentId', 'Estabelecimento não pertence a este cliente.');
      }
      if (b.contractServiceId) {
        const services = await clientServices(trx, auth.institutionId, client.id);
        if (!services.some((s) => s.id === b.contractServiceId)) throw fieldError('contractServiceId', 'Serviço não pertence a um contrato vigente deste cliente.');
      }
      const people2 = [b.responsibleId, ...b.participantIds];
      const conflicts = scheduleConflicts(people2, b.startsAt, b.endsAt, await busyOf(trx, auth.institutionId, people2, b.startsAt, b.endsAt), before?.id ?? null);
      if (conflicts.length && !b.allowOverlap) {
        const names = new Map(people.map((p) => [p.userId, p.name]));
        throw new HttpError(409, 'conflito_agenda', 'Há outra atividade agendada no mesmo horário para a equipe escolhida.', conflicts.map((c) => ({
          path: 'startsAt', message: `${names.get(c.userId) ?? 'Profissional'}: ${c.title} (${c.clientName}), ${formatDate(c.startsAt, tz)}–${formatDate(c.endsAt, tz).slice(11)}`,
        })));
      }
      const moved = before && (before.starts_at.toISOString() !== new Date(b.startsAt).toISOString() || before.ends_at.toISOString() !== new Date(b.endsAt).toISOString());
      if (moved && (!b.reason || b.reason.length < 5)) throw fieldError('reason', 'Informe o motivo da remarcação (mínimo 5 caracteres).');
      const values = {
        kind: b.kind, mode: b.mode, title: b.title, description: b.description, starts_at: new Date(b.startsAt), ends_at: new Date(b.endsAt), location: b.location,
        establishment_id: b.establishmentId, contract_service_id: b.contractServiceId, responsible_id: b.responsibleId, updated_at: new Date(),
      };
      const after = before
        ? await trx.updateTable('consulting_activity').set({ ...values, row_version: before.row_version + 1 }).where('id', '=', before.id).returningAll().executeTakeFirstOrThrow()
        : await trx.insertInto('consulting_activity').values({ ...values, institution_id: auth.institutionId, client_id: client.id, created_by: auth.userId, created_by_name: auth.displayName, data_origin: origin })
          .returningAll().executeTakeFirstOrThrow();
      const previous = before ? (await trx.selectFrom('consulting_activity_participant').select('user_id').where('activity_id', '=', before.id).execute()).map((p) => p.user_id) : [];
      if (before) await trx.deleteFrom('consulting_activity_participant').where('activity_id', '=', before.id).execute();
      if (b.participantIds.length) await trx.insertInto('consulting_activity_participant').values(b.participantIds.map((user_id) => ({ activity_id: after.id, user_id, institution_id: auth.institutionId }))).execute();
      await audit(trx, actorOf(req), {
        action: before ? 'update' : 'create', entity: 'consulting_activity', entityId: after.id, before: before ? { ...before, participants: previous } : null,
        after: { ...after, participants: b.participantIds }, context: { ...(conflicts.length ? { overlapAccepted: conflicts.map((c) => c.activityId) } : {}), ...(b.reason ? { justification: b.reason } : {}) },
      });
      const when = `${formatDate(after.starts_at.toISOString(), tz)} a ${formatDate(after.ends_at.toISOString(), tz).slice(11)}`;
      if (!before) await activityEvent(trx, auth, after.id, 'agendada', `${ACTIVITY_KIND_LABEL[b.kind]} agendada para ${when}.`, conflicts.length ? 'Agendada com sobreposição de horário aceita.' : null);
      else if (moved) await activityEvent(trx, auth, after.id, 'remarcada', `Remarcada de ${formatDate(before.starts_at.toISOString(), tz)} para ${when}.`, b.reason);
      else await activityEvent(trx, auth, after.id, 'alterada', 'Dados da atividade alterados.', b.reason);
      return detail(trx, auth, after);
    });
  };
  app.post<{ Params: { id: string } }>('/consulting/clients/:id/activities', edit, async (req, reply) => {
    const r = await saveActivity(req, parse(Uuid, req.params.id), null);
    reply.code(201);
    return r;
  });
  app.put<{ Params: { id: string } }>('/consulting/activities/:id', edit, async (req) => saveActivity(req, null, parse(Uuid, req.params.id)));

  /**
   * What happened: realized (summary, duration, optional delivery of the linked service and the
   * follow-up tasks), not realized (reason) or cancelled (reason). Final: the activity is not changed after.
   */
  app.post<{ Params: { id: string } }>('/consulting/activities/:id/outcome', editOrRecord, async (req) => {
    const auth = requireAuth(req);
    const b = parse(OutcomeBody, req.body);
    const tz = await timezoneOf(db, auth.institutionId);
    const today = todayIn(tz);
    const problems = checkOutcome(b, today);
    if (problems.length) throw problemsError(problems);
    // Cancelling is an agenda change; recording what happened belongs to who records activities.
    const needed = b.status === 'cancelada' ? 'consultoria:agenda:edit' : 'consultoria:agenda:record';
    if (!auth.permissions.includes(needed)) throw new HttpError(403, 'sem_permissao', 'Seu perfil não tem permissão para esta ação.');
    if (b.registerDelivery && !auth.permissions.includes('consultoria:contracts:deliveries')) throw fieldError('registerDelivery', 'Seu perfil não registra entregas de contrato.');
    return db.transaction().execute(async (trx) => {
      const a = await findActivity(trx, auth, parse(Uuid, req.params.id), true);
      if (a.row_version !== b.rowVersion) throw conflict();
      if (a.status !== 'agendada') throw new HttpError(409, 'atividade_registrada', `Atividade já ${ACTIVITY_STATUS_LABEL[a.status].toLowerCase()}.`);
      if (b.status !== 'cancelada' && a.starts_at.getTime() > Date.now()) throw fieldError('status', 'A atividade ainda não começou: registre o que aconteceu depois do início (ou cancele).');
      if (b.registerDelivery && !a.contract_service_id) throw fieldError('registerDelivery', 'A atividade não está ligada a um serviço contratado.');
      const people = new Set((await eligiblePeople(trx, auth.institutionId, a.client_id, today)).map((p) => p.userId));
      const badOwner = b.tasks.findIndex((t) => !people.has(t.ownerId));
      if (badOwner >= 0) throw fieldError(`tasks.${badOwner}.ownerId`, 'O responsável pela pendência deve ser da equipe com acesso a este cliente.');
      const after = await trx.updateTable('consulting_activity').set({
        status: b.status, outcome_summary: b.status === 'realizada' ? b.summary : null, outcome_detail: b.status === 'realizada' ? b.detail : null,
        actual_minutes: b.status === 'realizada' ? b.actualMinutes : null, close_reason: b.status === 'realizada' ? null : b.reason,
        recorded_by_name: auth.displayName, recorded_at: new Date(), updated_at: new Date(), row_version: a.row_version + 1,
      }).where('id', '=', a.id).returningAll().executeTakeFirstOrThrow();
      let delivery: string | null = null;
      if (b.registerDelivery && a.contract_service_id) {
        const line = await trx.selectFrom('contract_service as s').innerJoin('contract as k', 'k.id', 's.contract_id')
          .select(['s.id', 's.unit', 's.starts_on', 's.ends_on', 'k.status', 'k.ends_on as contract_ends_on', 'k.closed_on', 'k.code']).where('s.id', '=', a.contract_service_id).executeTakeFirstOrThrow();
        const day = dateInZone(a.starts_at, tz);
        const end = [line.ends_on, line.contract_ends_on, line.closed_on].filter((d): d is string => !!d).sort()[0] ?? null;
        if (line.status === 'proposta' || line.status === 'recusada' || !line.starts_on || day < line.starts_on || (end && day > end)) {
          throw fieldError('registerDelivery', `A data da atividade está fora da vigência do serviço no contrato ${line.code}.`);
        }
        const row = await trx.insertInto('contract_delivery').values({
          institution_id: auth.institutionId, service_id: line.id, occurred_on: day, quantity: deliveredQuantity(line.unit, b.actualMinutes!), description: `${ACTIVITY_KIND_LABEL[a.kind as ActivityKind]}: ${a.title}`,
          created_by: auth.userId, created_by_name: auth.displayName, activity_id: a.id,
        }).returningAll().executeTakeFirstOrThrow();
        delivery = row.id;
        await audit(trx, actorOf(req), { action: 'create', entity: 'contract_delivery', entityId: row.id, after: row, context: { contract: line.code, activity: a.id } });
      }
      for (const t of b.tasks) {
        const task = await trx.insertInto('consulting_task').values({ institution_id: auth.institutionId, client_id: a.client_id, activity_id: a.id, description: t.description, owner_id: t.ownerId, due_on: t.dueOn, created_by: auth.userId, created_by_name: auth.displayName })
          .returningAll().executeTakeFirstOrThrow();
        await activityEvent(trx, auth, a.id, 'pendencia', `Pendência: ${t.description} (prazo ${formatDate(t.dueOn)}).`);
        await audit(trx, actorOf(req), { action: 'create', entity: 'consulting_task', entityId: task.id, after: task });
      }
      await audit(trx, actorOf(req), { action: 'update', entity: 'consulting_activity', entityId: a.id, before: { status: a.status }, after: { status: b.status, actualMinutes: after.actual_minutes, delivery }, context: b.reason ? { justification: b.reason } : undefined });
      const label = ACTIVITY_KIND_LABEL[a.kind as ActivityKind];
      const summaryText = b.status === 'realizada' ? `${label} realizada${delivery ? ' (entrega registrada no contrato)' : ''}.` : `${label} ${b.status === 'cancelada' ? 'cancelada' : 'não realizada'}.`;
      await activityEvent(trx, auth, a.id, b.status, summaryText, b.status === 'realizada' ? b.summary : b.reason);
      // The client timeline keeps what happened with the client (not the scheduling itself).
      if (b.status !== 'cancelada') {
        await clientEvent(trx, auth, a.client_id, 'atividade', `${label} ${b.status === 'realizada' ? 'realizada' : 'não realizada'}: ${a.title}.`, b.status === 'realizada' ? b.summary : b.reason, dateInZone(a.starts_at, tz));
      }
      return detail(trx, auth, after);
    });
  });

  /* ---------- Tasks ---------- */

  app.post<{ Params: { id: string } }>('/consulting/activities/:id/tasks', record, async (req, reply) => {
    const auth = requireAuth(req);
    const b = parse(TaskBody, req.body);
    const today = todayIn(await timezoneOf(db, auth.institutionId));
    const problems = checkTask(b, today);
    if (problems.length) throw problemsError(problems);
    return db.transaction().execute(async (trx) => {
      const a = await findActivity(trx, auth, parse(Uuid, req.params.id));
      if (a.status === 'cancelada') throw new HttpError(409, 'atividade_cancelada', 'Atividade cancelada não recebe pendências.');
      const people = new Set((await eligiblePeople(trx, auth.institutionId, a.client_id, today)).map((p) => p.userId));
      if (!people.has(b.ownerId)) throw fieldError('ownerId', 'O responsável pela pendência deve ser da equipe com acesso a este cliente.');
      const task = await trx.insertInto('consulting_task').values({ institution_id: auth.institutionId, client_id: a.client_id, activity_id: a.id, description: b.description, owner_id: b.ownerId, due_on: b.dueOn, created_by: auth.userId, created_by_name: auth.displayName })
        .returningAll().executeTakeFirstOrThrow();
      await activityEvent(trx, auth, a.id, 'pendencia', `Pendência: ${b.description} (prazo ${formatDate(b.dueOn)}).`);
      await audit(trx, actorOf(req), { action: 'create', entity: 'consulting_task', entityId: task.id, after: task });
      reply.code(201);
      return detail(trx, auth, a);
    });
  });

  app.get('/consulting/tasks', view, async (req): Promise<Paged<TaskDto>> => {
    const auth = requireAuth(req);
    const q = parse(TaskQuery, req.query);
    const today = todayIn(await timezoneOf(db, auth.institutionId));
    let list = db.selectFrom('consulting_task as t').where('t.institution_id', '=', auth.institutionId);
    const scope = scopeOf(auth);
    if (scope) list = list.where('t.client_id', 'in', scope.length ? scope : [NO_ID]);
    if (q.mine) list = list.where('t.owner_id', '=', auth.userId);
    if (q.clientId) list = list.where('t.client_id', '=', q.clientId);
    if (q.status === 'atrasada') list = list.where('t.status', '=', 'aberta').where('t.due_on', '<', today);
    else if (q.status) list = list.where('t.status', '=', q.status);
    const [rows, total] = await Promise.all([
      list.selectAll('t').orderBy(sql`t.status = 'aberta'`, 'desc').orderBy('t.due_on').orderBy('t.created_at').limit(q.pageSize).offset((q.page - 1) * q.pageSize).execute(),
      list.select((e) => e.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { rows: await taskDtos(db, rows, today), total: Number(total.n), page: q.page, pageSize: q.pageSize };
  });

  /** Concluded or cancelled once, with a note, by its owner or by whoever records activities. */
  app.post<{ Params: { id: string } }>('/consulting/tasks/:id/close', view, async (req) => {
    const auth = requireAuth(req);
    const b = parse(CloseTaskBody, req.body);
    const today = todayIn(await timezoneOf(db, auth.institutionId));
    return db.transaction().execute(async (trx) => {
      const t = await trx.selectFrom('consulting_task').selectAll().where('id', '=', parse(Uuid, req.params.id)).where('institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst();
      if (!t || !inScope(auth, t.client_id)) throw notFound('Pendência');
      if (t.owner_id !== auth.userId && !auth.permissions.includes('consultoria:agenda:record')) throw new HttpError(403, 'sem_permissao', 'Só o responsável ou quem registra atividades encerra a pendência.');
      if (t.row_version !== b.rowVersion) throw conflict();
      if (t.status !== 'aberta') throw new HttpError(409, 'pendencia_encerrada', 'Esta pendência já foi encerrada.');
      const after = await trx.updateTable('consulting_task').set({ status: b.status, closed_note: b.note, closed_by_name: auth.displayName, closed_at: new Date(), row_version: t.row_version + 1 })
        .where('id', '=', t.id).returningAll().executeTakeFirstOrThrow();
      if (t.activity_id) await activityEvent(trx, auth, t.activity_id, 'pendencia_encerrada', `Pendência ${b.status === 'concluida' ? 'concluída' : 'cancelada'}: ${t.description}.`, b.note);
      await audit(trx, actorOf(req), { action: 'update', entity: 'consulting_task', entityId: t.id, before: { status: t.status }, after: { status: after.status }, context: { justification: b.note } });
      const [dto] = await taskDtos(trx, [after], today);
      return dto;
    });
  });

  /* ---------- Calendar export ---------- */

  /** The person's (or the visible team's) activities as an iCalendar file for their own calendar application. */
  app.get('/consulting/agenda.ics', view, async (req, reply) => {
    const auth = requireAuth(req);
    const q = parse(IcsQuery, req.query);
    const tz = await timezoneOf(db, auth.institutionId);
    const today = todayIn(tz);
    const from = q.from ?? today.slice(0, 8) + '01';
    const to = q.to ?? null;
    let list = listBase(auth).where('a.ends_at', '>', new Date(`${from}T00:00:00Z`)).where('a.status', 'in', [...ACTIVE_STATUSES, 'realizada', 'cancelada', 'nao_realizada']);
    if (to) list = list.where('a.starts_at', '<', new Date(`${to}T23:59:59Z`));
    if (q.mine) list = withPerson(list, auth.userId);
    const rows = await list.selectAll('a').orderBy('a.starts_at').limit(2000).execute();
    const dtos = await summaries(db, rows, new Date());
    await audit(db, actorOf(req), { action: 'export', entity: 'consulting_activity', entityId: null, context: { format: 'ics', count: rows.length, mine: !!q.mine } });
    const ics = agendaIcs(q.mine ? `Agenda de ${auth.displayName}` : 'Agenda da consultoria', dtos.map((a, i) => ({
      id: a.id, title: `${ACTIVITY_KIND_LABEL[a.kind]} — ${a.clientName}: ${a.title}`, startsAt: a.startsAt, endsAt: a.endsAt,
      location: [a.establishmentName, a.location].filter(Boolean).join(' · ') || null,
      description: [`Responsável: ${a.responsible.name}`, a.participants.length ? `Participantes: ${a.participants.map((p) => p.name).join(', ')}` : null, `Situação: ${ACTIVITY_STATUS_LABEL[a.status]}`].filter(Boolean).join('\n'),
      status: a.status, updatedAt: rows[i]!.updated_at.toISOString(),
    })));
    reply.header('content-type', 'text/calendar; charset=utf-8').header('content-disposition', `attachment; filename="agenda-${today}.ics"`);
    return ics;
  });
}
