import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import {
  ASSIGNMENT_ROLE_LABEL, SPECIALTY_LABEL, UF, checkClient, checkContact, checkEstablishment, checkUnit, clientInScope, normalizeCnpj, todayIn,
  type AssignmentDto, type ClientDetailDto, type ClientEventKind, type ClientSummaryDto, type ContactDto, type EstablishmentDto, type Paged, type TeamMemberDto, type UnitDto,
} from '@ccih/domain';
import type { DB, ClientTable, ClientEstablishmentTable } from '../db/types';
import { audit } from '../audit/audit';
import { actorOf, requireAuth, requirePermission, type AuthContext } from '../http/auth';
import { HttpError, conflict, notFound, parse } from '../http/errors';
import { IsoDate, OptionalText, PageQuery, RowVersion, Text, Uuid } from '../http/schemas';
import { escapeLike, institutionOrigin } from '../repositories/clinical';

export type Db = Kysely<DB> | Transaction<DB>;
export const NO_ID = '00000000-0000-0000-0000-000000000000';

const Address = z.object({
  street: OptionalText(160), number: OptionalText(20), district: OptionalText(80), city: OptionalText(80),
  state: z.enum(UF).nullable(), zip: z.string().trim().max(12).nullable().transform((v) => (v ? v.replace(/\D/g, '') : null)),
}).strict();
const Kind = z.enum(['hospital', 'clinica', 'ambulatorio', 'pronto_atendimento', 'ubs', 'laboratorio', 'servico_imagem', 'home_care', 'ilpi', 'odontologia', 'outro']);
const Cnpj = z.string().trim().max(20).nullable().transform((v) => (v ? normalizeCnpj(v) : null));
const ClientBody = z.object({
  legalName: Text(200), tradeName: OptionalText(200), cnpj: Cnpj, kind: Kind, status: z.enum(['prospecto', 'ativo', 'suspenso', 'encerrado']),
  email: OptionalText(160), phone: OptionalText(30), address: Address, servicesSummary: OptionalText(2000),
  internalNotes: OptionalText(4000).optional(), rowVersion: RowVersion.nullable(),
}).strict();
const ContactBody = z.object({
  kind: z.enum(['responsavel_tecnico', 'responsavel_administrativo', 'contato_autorizado']), name: Text(160), roleTitle: OptionalText(120), registry: OptionalText(40),
  email: OptionalText(160), phone: OptionalText(30), active: z.boolean(), rowVersion: RowVersion.nullable(),
}).strict();
const EstablishmentBody = z.object({
  name: Text(200), cnes: z.string().trim().max(12).nullable().transform((v) => (v ? v.replace(/\D/g, '') : null)), cnpj: Cnpj, kind: Kind,
  beds: z.number().int().nullable(), address: Address, active: z.boolean(), rowVersion: RowVersion.nullable(),
}).strict();
const UnitBody = z.object({
  name: Text(120), kind: z.enum(['uti_adulto', 'uti_pediatrica', 'uti_neonatal', 'internacao', 'centro_cirurgico', 'cme', 'emergencia', 'ambulatorio', 'hemodialise', 'apoio', 'outro']),
  beds: z.number().int().nullable(), active: z.boolean(), rowVersion: RowVersion.nullable(),
}).strict();
const AssignBody = z.object({
  userId: Uuid, role: z.enum(['responsavel', 'apoio']), specialty: z.enum(['ccih', 'cme', 'qualidade', 'seguranca_paciente', 'gestao']).nullable(),
  startsOn: IsoDate.nullable(), reason: z.string().trim().min(5, 'Informe o motivo (mínimo 5 caracteres).').max(500),
}).strict();
const EndAssignmentBody = z.object({ endsOn: IsoDate.nullable(), reason: z.string().trim().min(5, 'Informe o motivo (mínimo 5 caracteres).').max(500) }).strict();
const EventBody = z.object({ kind: z.enum(['atendimento', 'observacao']), summary: Text(200), detail: OptionalText(4000), occurredOn: IsoDate.nullable() }).strict();
const ListQuery = z.object({
  q: z.string().trim().max(80).optional(), status: z.enum(['prospecto', 'ativo', 'suspenso', 'encerrado']).optional(), kind: Kind.optional(), consultantId: Uuid.optional(), ...PageQuery,
}).strict();

export const problemsError = (problems: Array<{ path: string; message: string }>) => new HttpError(400, 'validacao', problems[0]!.message, problems);
export const fieldError = (path: string, message: string) => problemsError([{ path, message }]);

/** Clients this person may see: null = every client of the consultancy. */
export const scopeOf = (auth: AuthContext) => auth.clientScope;
export const inScope = (auth: AuthContext, clientId: string) => clientInScope(scopeOf(auth), clientId);

export async function institutionToday(db: Db, institutionId: string) {
  const inst = await db.selectFrom('institution').select('timezone').where('id', '=', institutionId).executeTakeFirstOrThrow();
  return todayIn(inst.timezone);
}

/** The client, if it exists in the user's organization and is within their scope (404 otherwise, as if it did not exist). */
export async function findClient(db: Db, auth: AuthContext, id: string, lock = false): Promise<Selectable<ClientTable>> {
  let q = db.selectFrom('client').selectAll().where('id', '=', id).where('institution_id', '=', auth.institutionId);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row || !inScope(auth, row.id)) throw notFound('Cliente');
  return row;
}

async function findEstablishment(db: Db, auth: AuthContext, id: string): Promise<Selectable<ClientEstablishmentTable>> {
  const row = await db.selectFrom('client_establishment').selectAll().where('id', '=', id).where('institution_id', '=', auth.institutionId).executeTakeFirst();
  if (!row || !inScope(auth, row.client_id)) throw notFound('Estabelecimento');
  return row;
}

export async function event(trx: Db, auth: AuthContext, clientId: string, kind: ClientEventKind, summary: string, detail: string | null, occurredOn: string, contractId: string | null = null) {
  await trx.insertInto('client_event').values({ institution_id: auth.institutionId, client_id: clientId, kind, summary, detail, occurred_on: occurredOn, actor_id: auth.userId, actor_name: auth.displayName, contract_id: contractId }).execute();
}

const addressOf = (r: { street: string | null; number: string | null; district: string | null; city: string | null; state: string | null; zip: string | null }) =>
  ({ street: r.street, number: r.number, district: r.district, city: r.city, state: r.state as never, zip: r.zip });
const addressColumns = (a: z.infer<typeof Address>) => ({ street: a.street, number: a.number, district: a.district, city: a.city, state: a.state, zip: a.zip });

async function summaries(db: Db, ids: string[]): Promise<ClientSummaryDto[]> {
  if (!ids.length) return [];
  const rows = await db.selectFrom('client as c')
    .select((eb) => [
      'c.id', 'c.legal_name', 'c.trade_name', 'c.cnpj', 'c.kind', 'c.status', 'c.city', 'c.state', 'c.updated_at', 'c.data_origin',
      eb.selectFrom('client_establishment as e').select((x) => x.fn.countAll<string>().as('n')).whereRef('e.client_id', '=', 'c.id').where('e.active', '=', true).as('establishments'),
      eb.selectFrom('client_assignment as a').select((x) => x.fn.countAll<string>().as('n')).whereRef('a.client_id', '=', 'c.id').where('a.ends_on', 'is', null).as('consultants'),
    ])
    .where('c.id', 'in', ids).execute();
  const responsible = await db.selectFrom('client_assignment as a').innerJoin('app_user as u', 'u.id', 'a.user_id').select(['a.client_id', 'u.id as user_id', 'u.display_name'])
    .where('a.client_id', 'in', ids).where('a.role', '=', 'responsavel').where('a.ends_on', 'is', null).execute();
  const byClient = new Map(responsible.map((r) => [r.client_id, { userId: r.user_id, name: r.display_name }]));
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!).map((r) => ({
    id: r.id, legalName: r.legal_name, tradeName: r.trade_name, cnpj: r.cnpj, kind: r.kind as never, status: r.status, city: r.city, state: r.state as never,
    establishments: Number(r.establishments ?? 0), consultants: Number(r.consultants ?? 0), responsible: byClient.get(r.id) ?? null, updatedAt: r.updated_at.toISOString(), dataOrigin: r.data_origin,
  }));
}

async function detail(db: Db, auth: AuthContext, c: Selectable<ClientTable>): Promise<ClientDetailDto> {
  const [contacts, establishments, units, assignments, events] = await Promise.all([
    db.selectFrom('client_contact').selectAll().where('client_id', '=', c.id).where('institution_id', '=', auth.institutionId).orderBy('active', 'desc').orderBy('name').execute(),
    db.selectFrom('client_establishment').selectAll().where('client_id', '=', c.id).where('institution_id', '=', auth.institutionId).orderBy('active', 'desc').orderBy('name').execute(),
    db.selectFrom('client_unit as u').innerJoin('client_establishment as e', 'e.id', 'u.establishment_id').selectAll('u').where('e.client_id', '=', c.id).where('u.institution_id', '=', auth.institutionId).orderBy('u.name').execute(),
    db.selectFrom('client_assignment as a').innerJoin('app_user as u', 'u.id', 'a.user_id').selectAll('a').select('u.display_name').where('a.client_id', '=', c.id).where('a.institution_id', '=', auth.institutionId)
      .orderBy(sql`a.ends_on IS NULL`, 'desc').orderBy('a.starts_on', 'desc').execute(),
    db.selectFrom('client_event').selectAll().where('client_id', '=', c.id).where('institution_id', '=', auth.institutionId).orderBy('occurred_on', 'desc').orderBy('created_at', 'desc').limit(200).execute(),
  ]);
  const unitDto = (u: (typeof units)[number]): UnitDto => ({ id: u.id, name: u.name, kind: u.kind as never, beds: u.beds, active: u.active, rowVersion: u.row_version });
  return {
    id: c.id, legalName: c.legal_name, tradeName: c.trade_name, cnpj: c.cnpj, kind: c.kind as never, status: c.status, email: c.email, phone: c.phone, address: addressOf(c),
    servicesSummary: c.services_summary, rowVersion: c.row_version, createdAt: c.created_at.toISOString(), updatedAt: c.updated_at.toISOString(), dataOrigin: c.data_origin,
    ...(auth.permissions.includes('consultoria:clients:internal_notes') ? { internalNotes: c.internal_notes } : {}),
    contacts: contacts.map((x): ContactDto => ({ id: x.id, kind: x.kind, name: x.name, roleTitle: x.role_title, registry: x.registry, email: x.email, phone: x.phone, active: x.active, rowVersion: x.row_version })),
    establishments: establishments.map((e): EstablishmentDto => ({
      id: e.id, name: e.name, cnes: e.cnes, cnpj: e.cnpj, kind: e.kind as never, beds: e.beds, address: addressOf(e), active: e.active, rowVersion: e.row_version,
      units: units.filter((u) => u.establishment_id === e.id).map(unitDto),
    })),
    assignments: assignments.map((a): AssignmentDto => ({
      id: a.id, userId: a.user_id, userName: a.display_name, role: a.role, specialty: a.specialty as never, startsOn: a.starts_on, endsOn: a.ends_on,
      assignedBy: a.assigned_by_name, reason: a.reason, endedBy: a.ended_by_name, endReason: a.end_reason,
    })),
    events: events.map((e) => ({ id: e.id, kind: e.kind as ClientEventKind, summary: e.summary, detail: e.detail, occurredOn: e.occurred_on, by: e.actor_name, at: e.created_at.toISOString() })),
  };
}

export async function consultingClientRoutes(app: FastifyInstance, { db }: { db: Kysely<DB> }) {
  const view = { preHandler: requirePermission(db, 'consultoria:clients:view') };
  const edit = { preHandler: requirePermission(db, 'consultoria:clients:edit') };
  const record = { preHandler: requirePermission(db, 'consultoria:clients:record') };
  const assign = { preHandler: requirePermission(db, 'consultoria:portfolio:assign') };
  const teamView = { preHandler: requirePermission(db, 'consultoria:portfolio:assign', 'consultoria:portfolio:all') };

  /* ---------- Clients ---------- */

  app.get('/consulting/clients', view, async (req): Promise<Paged<ClientSummaryDto>> => {
    const auth = requireAuth(req);
    const q = parse(ListQuery, req.query);
    let list = db.selectFrom('client as c').where('c.institution_id', '=', auth.institutionId);
    const scope = scopeOf(auth);
    if (scope) list = list.where('c.id', 'in', scope.length ? scope : [NO_ID]);
    if (q.status) list = list.where('c.status', '=', q.status);
    if (q.kind) list = list.where('c.kind', '=', q.kind);
    if (q.consultantId) list = list.where('c.id', 'in', db.selectFrom('client_assignment').select('client_id').where('user_id', '=', q.consultantId).where('institution_id', '=', auth.institutionId).where('ends_on', 'is', null));
    if (q.q) {
      const t = `%${escapeLike(q.q)}%`;
      const digits = q.q.replace(/\D/g, '');
      list = list.where((eb) => eb.or([eb('c.legal_name', 'ilike', t), eb('c.trade_name', 'ilike', t), eb('c.city', 'ilike', t), ...(digits.length >= 4 ? [eb('c.cnpj', 'like', `%${digits}%`)] : [])]));
    }
    const [ids, total] = await Promise.all([
      list.select('c.id').orderBy('c.legal_name').limit(q.pageSize).offset((q.page - 1) * q.pageSize).execute(),
      list.select((e) => e.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { rows: await summaries(db, ids.map((r) => r.id)), total: Number(total.n), page: q.page, pageSize: q.pageSize };
  });

  app.get<{ Params: { id: string } }>('/consulting/clients/:id', view, async (req) => {
    const auth = requireAuth(req);
    return detail(db, auth, await findClient(db, auth, parse(Uuid, req.params.id)));
  });

  const saveClient = async (req: FastifyRequest, id: string | null) => {
    const auth = requireAuth(req);
    const b = parse(ClientBody, req.body);
    const problems = checkClient({ ...b, address: b.address as never });
    if (problems.length) throw problemsError(problems);
    const notes = auth.permissions.includes('consultoria:clients:internal_notes');
    if (b.internalNotes !== undefined && !notes) throw fieldError('internalNotes', 'Seu perfil não edita as observações internas.');
    const origin = await institutionOrigin(db, auth.institutionId);
    const today = await institutionToday(db, auth.institutionId);
    return db.transaction().execute(async (trx) => {
      const before = id ? await findClient(trx, auth, id, true) : null;
      if (before && before.row_version !== b.rowVersion) throw conflict();
      if (b.cnpj) {
        const dup = await trx.selectFrom('client').select('id').where('institution_id', '=', auth.institutionId).where('cnpj', '=', b.cnpj).where('id', '!=', id ?? NO_ID).executeTakeFirst();
        if (dup) throw fieldError('cnpj', 'Já existe um cliente com este CNPJ na carteira.');
      }
      const values = {
        legal_name: b.legalName, trade_name: b.tradeName, cnpj: b.cnpj, kind: b.kind, status: b.status, email: b.email, phone: b.phone, ...addressColumns(b.address),
        services_summary: b.servicesSummary, ...(notes && b.internalNotes !== undefined ? { internal_notes: b.internalNotes } : {}), updated_at: new Date(),
      };
      const after = before
        ? await trx.updateTable('client').set({ ...values, row_version: before.row_version + 1 }).where('id', '=', before.id).returningAll().executeTakeFirstOrThrow()
        : await trx.insertInto('client').values({ ...values, institution_id: auth.institutionId, created_by: auth.userId, created_by_name: auth.displayName, data_origin: origin }).returningAll().executeTakeFirstOrThrow();
      const { internal_notes: _a, ...beforeLog } = before ?? ({} as Selectable<ClientTable>);
      const { internal_notes: _b, ...afterLog } = after;
      await audit(trx, actorOf(req), { action: before ? 'update' : 'create', entity: 'client', entityId: after.id, before: before ? beforeLog : null, after: afterLog, context: { internalNotesChanged: before ? before.internal_notes !== after.internal_notes : !!after.internal_notes } });
      if (!before) await event(trx, auth, after.id, 'cadastro', `Cliente cadastrado por ${auth.displayName}.`, null, today);
      else {
        const changed = (['legal_name', 'trade_name', 'cnpj', 'kind', 'status', 'email', 'phone', 'city', 'state', 'services_summary'] as const).filter((k) => before[k] !== after[k]);
        if (changed.length) await event(trx, auth, after.id, 'alteracao', before.status !== after.status ? `Situação: ${before.status} → ${after.status}.` : 'Cadastro atualizado.', `Campos alterados: ${changed.join(', ')}`, today);
      }
      return detail(trx, auth, after);
    });
  };
  app.post('/consulting/clients', edit, async (req, reply) => {
    const r = await saveClient(req, null);
    reply.code(201);
    return r;
  });
  app.put<{ Params: { id: string } }>('/consulting/clients/:id', edit, async (req) => saveClient(req, parse(Uuid, req.params.id)));

  /* ---------- Contacts ---------- */

  const saveContact = async (req: FastifyRequest, clientId: string | null, contactId: string | null) => {
    const auth = requireAuth(req);
    const b = parse(ContactBody, req.body);
    const problems = checkContact(b);
    if (problems.length) throw problemsError(problems);
    return db.transaction().execute(async (trx) => {
      const before = contactId ? await trx.selectFrom('client_contact').selectAll().where('id', '=', contactId).where('institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst() : null;
      if (contactId && (!before || !inScope(auth, before.client_id))) throw notFound('Contato');
      const client = await findClient(trx, auth, before?.client_id ?? clientId!);
      if (before && before.row_version !== b.rowVersion) throw conflict();
      const values = { kind: b.kind, name: b.name, role_title: b.roleTitle, registry: b.registry, email: b.email, phone: b.phone, active: b.active, updated_at: new Date() };
      const after = before
        ? await trx.updateTable('client_contact').set({ ...values, row_version: before.row_version + 1 }).where('id', '=', before.id).returningAll().executeTakeFirstOrThrow()
        : await trx.insertInto('client_contact').values({ ...values, institution_id: auth.institutionId, client_id: client.id }).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: before ? 'update' : 'create', entity: 'client_contact', entityId: after.id, before: before ?? null, after });
      return detail(trx, auth, client);
    });
  };
  app.post<{ Params: { id: string } }>('/consulting/clients/:id/contacts', edit, async (req) => saveContact(req, parse(Uuid, req.params.id), null));
  app.put<{ Params: { id: string } }>('/consulting/contacts/:id', edit, async (req) => saveContact(req, null, parse(Uuid, req.params.id)));

  /* ---------- Establishments and units ---------- */

  const saveEstablishment = async (req: FastifyRequest, clientId: string | null, establishmentId: string | null) => {
    const auth = requireAuth(req);
    const b = parse(EstablishmentBody, req.body);
    const problems = checkEstablishment({ ...b, address: b.address as never });
    if (problems.length) throw problemsError(problems);
    return db.transaction().execute(async (trx) => {
      const before = establishmentId ? await findEstablishment(trx, auth, establishmentId) : null;
      const client = await findClient(trx, auth, before?.client_id ?? clientId!);
      if (before && before.row_version !== b.rowVersion) throw conflict();
      const values = { name: b.name, cnes: b.cnes, cnpj: b.cnpj, kind: b.kind, beds: b.beds, ...addressColumns(b.address), active: b.active, updated_at: new Date() };
      const after = before
        ? await trx.updateTable('client_establishment').set({ ...values, row_version: before.row_version + 1 }).where('id', '=', before.id).returningAll().executeTakeFirstOrThrow()
        : await trx.insertInto('client_establishment').values({ ...values, institution_id: auth.institutionId, client_id: client.id }).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: before ? 'update' : 'create', entity: 'client_establishment', entityId: after.id, before: before ?? null, after });
      return detail(trx, auth, client);
    });
  };
  app.post<{ Params: { id: string } }>('/consulting/clients/:id/establishments', edit, async (req) => saveEstablishment(req, parse(Uuid, req.params.id), null));
  app.put<{ Params: { id: string } }>('/consulting/establishments/:id', edit, async (req) => saveEstablishment(req, null, parse(Uuid, req.params.id)));

  const saveUnit = async (req: FastifyRequest, establishmentId: string | null, unitId: string | null) => {
    const auth = requireAuth(req);
    const b = parse(UnitBody, req.body);
    const problems = checkUnit(b);
    if (problems.length) throw problemsError(problems);
    return db.transaction().execute(async (trx) => {
      const before = unitId ? await trx.selectFrom('client_unit').selectAll().where('id', '=', unitId).where('institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst() : null;
      if (unitId && !before) throw notFound('Unidade');
      const establishment = await findEstablishment(trx, auth, before?.establishment_id ?? establishmentId!);
      if (before && before.row_version !== b.rowVersion) throw conflict();
      const values = { name: b.name, kind: b.kind, beds: b.beds, active: b.active, updated_at: new Date() };
      const after = before
        ? await trx.updateTable('client_unit').set({ ...values, row_version: before.row_version + 1 }).where('id', '=', before.id).returningAll().executeTakeFirstOrThrow()
        : await trx.insertInto('client_unit').values({ ...values, institution_id: auth.institutionId, establishment_id: establishment.id }).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: before ? 'update' : 'create', entity: 'client_unit', entityId: after.id, before: before ?? null, after });
      return detail(trx, auth, await findClient(trx, auth, establishment.client_id));
    });
  };
  app.post<{ Params: { id: string } }>('/consulting/establishments/:id/units', edit, async (req) => saveUnit(req, parse(Uuid, req.params.id), null));
  app.put<{ Params: { id: string } }>('/consulting/units/:id', edit, async (req) => saveUnit(req, null, parse(Uuid, req.params.id)));

  /* ---------- Team and assignments ---------- */

  /** People of the consultancy who can take clients (internal team only), with their current clients. */
  app.get('/consulting/team', teamView, async (req): Promise<{ members: TeamMemberDto[] }> => {
    const auth = requireAuth(req);
    const users = await db.selectFrom('app_user as u').select(['u.id', 'u.display_name', 'u.login', 'u.status'])
      .where('u.institution_id', '=', auth.institutionId).orderBy('u.display_name').execute();
    const roles = await db.selectFrom('user_role').select(['user_id', 'role_code']).where('institution_id', '=', auth.institutionId).execute();
    const active = await db.selectFrom('client_assignment as a').innerJoin('client as c', 'c.id', 'a.client_id').select(['a.user_id', 'a.client_id', 'a.role', 'a.specialty', 'c.legal_name', 'c.trade_name'])
      .where('a.institution_id', '=', auth.institutionId).where('a.ends_on', 'is', null).execute();
    return {
      members: users.map((u) => ({
        userId: u.id, name: u.display_name, login: u.login, active: u.status === 'ativo', roles: roles.filter((r) => r.user_id === u.id).map((r) => r.role_code),
        clients: active.filter((a) => a.user_id === u.id).map((a) => ({ clientId: a.client_id, clientName: a.trade_name ?? a.legal_name, role: a.role, specialty: a.specialty as never })),
      })),
    };
  });

  /**
   * Assigns a consultant to a client. Naming a new responsible consultant ends the current one's
   * responsibility in the same transaction (replacement keeps the history).
   */
  app.post<{ Params: { id: string } }>('/consulting/clients/:id/assignments', assign, async (req, reply) => {
    const auth = requireAuth(req);
    const b = parse(AssignBody, req.body);
    const today = await institutionToday(db, auth.institutionId);
    const startsOn = b.startsOn ?? today;
    if (startsOn > today) throw fieldError('startsOn', 'O início não pode estar no futuro: atribua no dia em que o consultor assume.');
    return db.transaction().execute(async (trx) => {
      const client = await findClient(trx, auth, parse(Uuid, req.params.id), true);
      const user = await trx.selectFrom('app_user').select(['id', 'display_name', 'status']).where('id', '=', b.userId).where('institution_id', '=', auth.institutionId).executeTakeFirst();
      if (!user) throw fieldError('userId', 'Profissional inexistente.');
      if (user.status !== 'ativo') throw fieldError('userId', 'A conta deste profissional não está ativa.');
      const roles = (await trx.selectFrom('user_role').select('role_code').where('user_id', '=', user.id).execute()).map((r) => r.role_code);
      if (!roles.some((r) => ['consultor', 'gestor_consultoria', 'admin'].includes(r))) throw fieldError('userId', 'Só consultores, gestores ou administradores da consultoria assumem clientes.');
      const current = await trx.selectFrom('client_assignment').selectAll().where('client_id', '=', client.id).where('institution_id', '=', auth.institutionId).where('ends_on', 'is', null).execute();
      if (current.some((a) => a.user_id === user.id)) throw new HttpError(409, 'ja_atribuido', `${user.display_name} já atende este cliente. Encerre a atribuição atual para mudar o papel.`);
      const previous = b.role === 'responsavel' ? current.find((a) => a.role === 'responsavel') : undefined;
      if (previous) {
        if (startsOn < previous.starts_on) throw fieldError('startsOn', 'A substituição não pode começar antes do início do responsável atual.');
        await trx.updateTable('client_assignment').set({ ends_on: startsOn, ended_by_name: auth.displayName, end_reason: `Substituído por ${user.display_name}: ${b.reason}` }).where('id', '=', previous.id).execute();
      }
      const created = await trx.insertInto('client_assignment').values({
        institution_id: auth.institutionId, client_id: client.id, user_id: user.id, role: b.role, specialty: b.specialty, starts_on: startsOn, assigned_by: auth.userId, assigned_by_name: auth.displayName, reason: b.reason,
      }).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'create', entity: 'client_assignment', entityId: created.id, before: previous ? { replaced: previous.id, userId: previous.user_id } : null, after: created, context: { justification: b.reason } });
      const label = `${ASSIGNMENT_ROLE_LABEL[b.role]}: ${user.display_name}${b.specialty ? ` (${SPECIALTY_LABEL[b.specialty]})` : ''}`;
      if (previous) {
        const old = await trx.selectFrom('app_user').select('display_name').where('id', '=', previous.user_id).executeTakeFirstOrThrow();
        await event(trx, auth, client.id, 'substituicao', `${label}, no lugar de ${old.display_name}.`, b.reason, startsOn);
      } else await event(trx, auth, client.id, 'atribuicao', label, b.reason, startsOn);
      reply.code(201);
      return detail(trx, auth, client);
    });
  });

  app.post<{ Params: { id: string } }>('/consulting/assignments/:id/end', assign, async (req) => {
    const auth = requireAuth(req);
    const b = parse(EndAssignmentBody, req.body);
    const today = await institutionToday(db, auth.institutionId);
    return db.transaction().execute(async (trx) => {
      const a = await trx.selectFrom('client_assignment as a').innerJoin('app_user as u', 'u.id', 'a.user_id').selectAll('a').select('u.display_name')
        .where('a.id', '=', parse(Uuid, req.params.id)).where('a.institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst();
      if (!a || !inScope(auth, a.client_id)) throw notFound('Atribuição');
      if (a.ends_on) throw new HttpError(409, 'ja_encerrada', 'Esta atribuição já foi encerrada.');
      const endsOn = b.endsOn ?? today;
      if (endsOn > today) throw fieldError('endsOn', 'O encerramento não pode estar no futuro.');
      if (endsOn < a.starts_on) throw fieldError('endsOn', 'O encerramento não pode ser anterior ao início.');
      await trx.updateTable('client_assignment').set({ ends_on: endsOn, ended_by_name: auth.displayName, end_reason: b.reason }).where('id', '=', a.id).execute();
      await audit(trx, actorOf(req), { action: 'update', entity: 'client_assignment', entityId: a.id, before: { endsOn: null }, after: { endsOn }, context: { justification: b.reason } });
      await event(trx, auth, a.client_id, 'encerramento_atribuicao', `${ASSIGNMENT_ROLE_LABEL[a.role]} ${a.display_name}: atribuição encerrada.`, b.reason, endsOn);
      return detail(trx, auth, await findClient(trx, auth, a.client_id));
    });
  });

  /* ---------- Timeline ---------- */

  app.post<{ Params: { id: string } }>('/consulting/clients/:id/events', record, async (req, reply) => {
    const auth = requireAuth(req);
    const b = parse(EventBody, req.body);
    const today = await institutionToday(db, auth.institutionId);
    const occurredOn = b.occurredOn ?? today;
    if (occurredOn > today) throw fieldError('occurredOn', 'A data do registro não pode estar no futuro.');
    return db.transaction().execute(async (trx) => {
      const client = await findClient(trx, auth, parse(Uuid, req.params.id));
      await event(trx, auth, client.id, b.kind, b.summary, b.detail, occurredOn);
      await audit(trx, actorOf(req), { action: 'create', entity: 'client_event', entityId: client.id, after: { kind: b.kind, summary: b.summary, occurredOn } });
      reply.code(201);
      return detail(trx, auth, client);
    });
  });
}
