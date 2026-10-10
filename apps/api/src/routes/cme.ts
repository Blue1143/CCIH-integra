import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import {
  addDays, bowieDickApplies, checkItemUse, checkLoadDecision, checkTestRecord, dateInZone, itemLabel, loadCode, rulesFromParameters, sterileUntil,
  todayIn, zonedInstant,
  type CmeOverview, type InstrumentSetDto, type LoadDetail, type LoadSummary, type Paged, type SterilizerDto, type TraceResult,
} from '@ccih/domain';
import type { DB } from '../db/types';
import { audit } from '../audit/audit';
import { actorOf, requireAuth, requirePermission, type AuthContext } from '../http/auth';
import { HttpError, conflict, notFound, parse } from '../http/errors';
import { Instant, IsoDate, Justification, OptionalText, PageQuery, RowVersion, Text, Uuid, notFuture } from '../http/schemas';
import { assertSector, escapeLike, institutionOrigin, surgerySummaries, type Db } from '../repositories/clinical';
import { currentOnly, evaluateLoads, loadPolicy, testDtos, traceRows, materialUseDtos } from '../repositories/cme';
import { openUseWithoutExitNc } from '../services/notifications';

const PACKAGING = z.enum(['papel_grau_cirurgico', 'sms', 'container_rigido', 'tecido_algodao', 'outro']);
const LOAD_STATUS = z.enum(['aguardando', 'liberada', 'retida', 'rejeitada', 'reprocessamento']);
const Code = (max: number) => z.string().trim().toLowerCase().regex(new RegExp(`^[a-z0-9-]{2,${max}}$`), 'Use letras minúsculas, números e hífen.');

const SterilizerBody = z
  .object({
    code: Code(20), name: Text(120), type: z.enum(['vapor_prevacuo', 'vapor_gravitacional', 'peroxido_plasma', 'oxido_etileno', 'outro']), serial: OptionalText(60),
    sectorId: Uuid, status: z.enum(['ativo', 'manutencao', 'inativo']), statusReason: OptionalText(300), qualificationDueOn: IsoDate.nullable(),
    rowVersion: RowVersion.nullable(), justification: Justification,
  })
  .strict()
  .refine((b) => b.status === 'ativo' || !!b.statusReason, { path: ['statusReason'], message: 'Informe o motivo do bloqueio ou da inativação.' });
const SetBody = z
  .object({
    code: Code(40), name: Text(160), specialty: OptionalText(80), composition: OptionalText(2000), itemCount: z.number().int().min(1).max(1000).nullable(),
    packaging: PACKAGING, implant: z.boolean(), active: z.boolean(), rowVersion: RowVersion.nullable(), justification: Justification,
  })
  .strict();
const LoadCreate = z
  .object({
    // Without a start the load is created "em montagem": packages are added by reading at the assembly station.
    sterilizerId: Uuid, program: Text(80), startedAt: Instant.refine(notFuture, 'Data no futuro.').nullable(), notes: OptionalText(1000), reprocessedFromId: Uuid.nullable(),
    items: z.array(z.object({ setId: Uuid.nullable(), description: OptionalText(200), quantity: z.number().int().min(1).max(500), packaging: PACKAGING.nullable(), implant: z.boolean().nullable() }).strict()).max(60),
  })
  .strict()
  .refine((b) => !b.startedAt || b.items.length > 0, { path: ['items'], message: 'Informe ao menos um pacote, ou crie a carga em montagem (sem início) e leia os pacotes.' });
const CycleStart = z.object({ startedAt: Instant.refine(notFuture, 'Data no futuro.'), rowVersion: RowVersion }).strict();
const CycleFinish = z
  .object({
    endedAt: Instant.refine(notFuture, 'Data no futuro.'), temperatureC: z.number().min(0).max(300).nullable(), pressureKpa: z.number().min(0).max(1000).nullable(),
    exposureMinutes: z.number().int().min(1).max(1440).nullable(), physicalResult: z.enum(['conforme', 'nao_conforme']), notes: OptionalText(1000), rowVersion: RowVersion,
  })
  .strict();
const TestCreate = z
  .object({
    sterilizerId: Uuid.nullable(), loadId: Uuid.nullable(), type: z.enum(['BOWIE_DICK', 'IQ1', 'IQ2', 'IQ3', 'IQ4', 'IQ5', 'IQ6', 'IB']), result: z.enum(['aprovado', 'reprovado', 'pendente']),
    performedAt: Instant.refine(notFuture, 'Data no futuro.'), indicatorLot: z.string().trim().max(40), indicatorExpiry: IsoDate.nullable(),
    incubationStart: Instant.nullable(), readAt: Instant.refine(notFuture, 'Data no futuro.').nullable(), controlResult: z.enum(['positivo', 'negativo']).nullable(), notes: OptionalText(1000),
  })
  .strict();
const TestReplace = z
  .object({
    result: z.enum(['aprovado', 'reprovado', 'pendente']), readAt: Instant.refine(notFuture, 'Data no futuro.').nullable(), controlResult: z.enum(['positivo', 'negativo']).nullable(),
    notes: OptionalText(1000), justification: z.string().trim().max(500).nullable(),
  })
  .strict();
const Decision = z.object({ status: LOAD_STATUS, justification: Justification, rowVersion: RowVersion }).strict();
const UseCreate = z.object({ labelCode: z.string().trim().toUpperCase().min(3).max(60), usedAt: Instant.refine(notFuture, 'Data no futuro.').nullable() }).strict();
const LooseUse = z.object({ labelCode: z.string().trim().toUpperCase().min(3).max(60), sectorId: Uuid, usedAt: Instant.refine(notFuture, 'Data no futuro.') }).strict();
const VoidBody = z.object({ justification: Justification }).strict();
const LoadQuery = z
  .object({ status: z.union([LOAD_STATUS, z.literal('pendentes')]).optional(), sterilizerId: Uuid.optional(), from: IsoDate.optional(), to: IsoDate.optional(), q: z.string().trim().max(40).optional(), ...PageQuery })
  .strict();

const fieldError = (path: string, message: string) => new HttpError(400, 'validacao', message, [{ path, message }]);
const problemsError = (problems: Array<{ path: string; message: string }>) => new HttpError(400, 'validacao', problems[0]!.message, problems);
const NO_ID = '00000000-0000-0000-0000-000000000000';

async function context(db: Db, institutionId: string) {
  const [inst, params] = await Promise.all([
    db.selectFrom('institution').select('timezone').where('id', '=', institutionId).executeTakeFirstOrThrow(),
    db.selectFrom('rule_parameter').select(['key', 'value', 'reference_id']).where('institution_id', '=', institutionId).execute(),
  ]);
  return { tz: inst.timezone, today: todayIn(inst.timezone), rules: rulesFromParameters(params.map((p) => ({ key: p.key, value: p.value, referenceId: p.reference_id }))) };
}

/** CME records follow the sector of the sterilizer: outside the user's scope they do not exist (404). */
const scopeOf = (auth: AuthContext) => (auth.scope ? (auth.scope.length ? auth.scope : [NO_ID]) : null);

async function findSterilizer(db: Db, auth: AuthContext, id: string) {
  let q = db.selectFrom('sterilizer').selectAll().where('id', '=', id).where('institution_id', '=', auth.institutionId);
  const scope = scopeOf(auth);
  if (scope) q = q.where('sector_id', 'in', scope);
  const row = await q.executeTakeFirst();
  if (!row) throw notFound('Equipamento');
  return row;
}

async function findLoad(db: Db, auth: AuthContext, id: string) {
  let q = db.selectFrom('sterilization_load as l').innerJoin('sterilizer as s', 's.id', 'l.sterilizer_id').selectAll('l').select(['s.sector_id', 's.type as sterilizer_type', 's.name as sterilizer_name'])
    .where('l.id', '=', id).where('l.institution_id', '=', auth.institutionId);
  const scope = scopeOf(auth);
  if (scope) q = q.where('s.sector_id', 'in', scope);
  const row = await q.executeTakeFirst();
  if (!row) throw notFound('Carga');
  return row;
}

/** A package by its printed label, with what decides whether it can be used. */
async function findItemByLabel(db: Db, auth: AuthContext, labelCode: string) {
  const item = await db.selectFrom('load_item as i').innerJoin('sterilization_load as l', 'l.id', 'i.load_id').innerJoin('sterilizer as s', 's.id', 'l.sterilizer_id')
    .select(['i.id', 'i.label_code', 'i.description', 'i.expires_on', 'i.set_id', 'i.process_id', 'l.status', 'l.code', 's.sector_id as cme_sector'])
    .where('i.institution_id', '=', auth.institutionId).where('i.label_code', '=', labelCode).executeTakeFirst();
  if (!item) throw fieldError('labelCode', 'Etiqueta não encontrada. Confira o código impresso no pacote.');
  const used = await db.selectFrom('material_use').select('id').where('item_id', '=', item.id).where('voided_at', 'is', null).executeTakeFirst();
  return { ...item, alreadyUsed: !!used };
}

async function sterilizerDtos(db: Db, auth: AuthContext, ids?: string[]): Promise<SterilizerDto[]> {
  const { tz, today } = await context(db, auth.institutionId);
  let q = db.selectFrom('sterilizer').selectAll().where('institution_id', '=', auth.institutionId);
  const scope = scopeOf(auth);
  if (scope) q = q.where('sector_id', 'in', scope);
  if (ids) q = q.where('id', 'in', ids.length ? ids : [NO_ID]);
  const rows = await q.orderBy('code').execute();
  if (!rows.length) return [];
  const [bd, loads] = await Promise.all([
    db.selectFrom('sterilization_test').select(['id', 'sterilizer_id', 'result', 'performed_at', 'replaces_id']).where('type', '=', 'BOWIE_DICK').where('performed_on', '=', today).where('sterilizer_id', 'in', rows.map((r) => r.id)).orderBy('performed_at').execute(),
    db.selectFrom('sterilization_load').select(['sterilizer_id', (e) => e.fn.countAll<string>().as('n')]).where('sterilizer_id', 'in', rows.map((r) => r.id))
      .where('started_at', '>=', zonedInstant(today, 0, tz)).where('started_at', '<', zonedInstant(addDays(today, 1), 0, tz)).groupBy('sterilizer_id').execute(),
  ]);
  const currentBd = currentOnly(bd);
  return rows.map((s) => ({
    id: s.id, code: s.code, name: s.name, type: s.type, serial: s.serial, sectorId: s.sector_id, status: s.status, statusReason: s.status_reason,
    qualificationDueOn: s.qualification_due_on, rowVersion: s.row_version, bowieDickApplies: bowieDickApplies(s.type),
    todayBowieDick: currentBd.filter((t) => t.sterilizer_id === s.id).at(-1)?.result ?? null,
    loadsToday: Number(loads.find((l) => l.sterilizer_id === s.id)?.n ?? 0),
  }));
}

async function loadSummaries(db: Db, auth: AuthContext, ids: string[]): Promise<LoadSummary[]> {
  if (!ids.length) return [];
  const { tz } = await context(db, auth.institutionId);
  const { policy } = await loadPolicy(db, auth.institutionId);
  const rows = await db.selectFrom('sterilization_load as l').innerJoin('sterilizer as s', 's.id', 'l.sterilizer_id')
    .select((eb) => [
      'l.id', 'l.code', 'l.sterilizer_id', 's.name', 'l.program', 'l.started_at', 'l.ended_at', 'l.physical_result', 'l.status', 'l.has_implant', 'l.data_origin', 'l.reprocessed_from_id',
      eb.selectFrom('load_item as i').select((e) => e.fn.countAll<string>().as('n')).whereRef('i.load_id', '=', 'l.id').as('items'),
      eb.selectFrom('load_item as i').innerJoin('material_use as u', 'u.item_id', 'i.id').select((e) => e.fn.countAll<string>().as('n')).whereRef('i.load_id', '=', 'l.id').where('u.voided_at', 'is', null).as('used'),
    ])
    .where('l.id', 'in', ids).execute();
  const evals = await evaluateLoads(db, auth.institutionId, ids, tz, policy);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    return [{
      id: r.id, code: r.code, sterilizerId: r.sterilizer_id, sterilizerName: r.name, program: r.program, startedAt: r.started_at?.toISOString() ?? null, endedAt: r.ended_at?.toISOString() ?? null,
      physical: r.physical_result, status: r.status, suggestion: evals.get(r.id)?.evaluation.status ?? 'aguardando', hasImplant: r.has_implant,
      items: Number(r.items ?? 0), used: Number(r.used ?? 0), origin: r.data_origin, reprocessedFromId: r.reprocessed_from_id,
    }];
  });
}

export async function cmeRoutes(app: FastifyInstance, { db }: { db: Kysely<DB> }) {
  const view = { preHandler: requirePermission(db, 'cme:view') };
  // Execution is split: assembling loads and recording cycles/uses, and recording tests; deciding is cme:release.
  const cycle = { preHandler: requirePermission(db, 'cme:cycle:record') };
  const tests = { preHandler: requirePermission(db, 'cme:test:record') };
  const release = { preHandler: requirePermission(db, 'cme:release') };
  const configure = { preHandler: requirePermission(db, 'cme:configure') };

  /* ---------- Overview ---------- */

  app.get('/cme/overview', view, async (req): Promise<CmeOverview> => {
    const auth = requireAuth(req);
    const { tz, today } = await context(db, auth.institutionId);
    const sterilizers = await sterilizerDtos(db, auth);
    const ids = sterilizers.length ? sterilizers.map((s) => s.id) : [NO_ID];
    const [byStatus, released, ib, recalled] = await Promise.all([
      db.selectFrom('sterilization_load').select(['status', (e) => e.fn.countAll<string>().as('n')]).where('sterilizer_id', 'in', ids).where('status', 'in', ['aguardando', 'retida']).groupBy('status').execute(),
      db.selectFrom('load_release_decision as d').innerJoin('sterilization_load as l', 'l.id', 'd.load_id').select((e) => e.fn.countAll<string>().as('n'))
        .where('l.sterilizer_id', 'in', ids).where('d.to_status', '=', 'liberada').where('d.decided_at', '>=', zonedInstant(today, 0, tz)).executeTakeFirstOrThrow(),
      db.selectFrom('sterilization_test').select(['id', 'replaces_id', 'result']).where('sterilizer_id', 'in', ids).where('type', '=', 'IB').where('performed_on', '>=', addDays(today, -30)).execute(),
      db.selectFrom('load_release_decision as d').innerJoin('sterilization_load as l', 'l.id', 'd.load_id').select((e) => e.fn.countAll<string>().as('n'))
        .where('l.sterilizer_id', 'in', ids).where('d.from_status', '=', 'liberada').where('d.to_status', '=', 'rejeitada').where('d.decided_at', '>=', zonedInstant(addDays(today, -30), 0, tz)).executeTakeFirstOrThrow(),
    ]);
    return {
      awaiting: Number(byStatus.find((r) => r.status === 'aguardando')?.n ?? 0), retained: Number(byStatus.find((r) => r.status === 'retida')?.n ?? 0),
      releasedToday: Number(released.n), ibPending: currentOnly(ib).filter((t) => t.result === 'pendente').length, recalled30d: Number(recalled.n), sterilizers,
    };
  });

  /* ---------- Sterilizers ---------- */

  app.get('/cme/sterilizers', view, async (req) => ({ sterilizers: await sterilizerDtos(db, requireAuth(req)) }));

  const saveSterilizer = async (auth: AuthContext, actor: ReturnType<typeof actorOf>, id: string | null, b: z.infer<typeof SterilizerBody>) => {
    const sector = await assertSector(db, auth, b.sectorId);
    if (sector.kind !== 'cme') throw fieldError('sectorId', 'Escolha um setor do tipo CME.');
    const values = { code: b.code, name: b.name, type: b.type, serial: b.serial, sector_id: b.sectorId, status: b.status, status_reason: b.status === 'ativo' ? null : b.statusReason, qualification_due_on: b.qualificationDueOn, updated_at: new Date() };
    return db.transaction().execute(async (trx) => {
      const dup = await trx.selectFrom('sterilizer').select('id').where('institution_id', '=', auth.institutionId).where('code', '=', b.code).executeTakeFirst();
      if (dup && dup.id !== id) throw fieldError('code', 'Já existe um equipamento com este código.');
      if (!id) {
        const created = await trx.insertInto('sterilizer').values({ institution_id: auth.institutionId, ...values }).returningAll().executeTakeFirstOrThrow();
        await audit(trx, actor, { action: 'create', entity: 'sterilizer', entityId: created.id, after: created, context: { justification: b.justification } });
        return { id: created.id, rowVersion: created.row_version };
      }
      const before = await trx.selectFrom('sterilizer').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
      if (before.row_version !== b.rowVersion) throw conflict();
      if (before.type !== b.type && (await trx.selectFrom('sterilization_load').select('id').where('sterilizer_id', '=', id).executeTakeFirst())) throw fieldError('type', 'O tipo não muda depois que o equipamento tem ciclos registrados; cadastre outro equipamento.');
      const after = await trx.updateTable('sterilizer').set({ ...values, row_version: before.row_version + 1 }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actor, { action: before.status !== after.status ? 'status_change' : 'update', entity: 'sterilizer', entityId: id, before, after, context: { justification: b.justification } });
      return { id, rowVersion: after.row_version };
    });
  };

  app.post('/cme/sterilizers', configure, async (req, reply) => {
    const auth = requireAuth(req);
    const b = parse(SterilizerBody, req.body);
    reply.code(201);
    return saveSterilizer(auth, actorOf(req), null, b);
  });

  app.put<{ Params: { id: string } }>('/cme/sterilizers/:id', configure, async (req) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(SterilizerBody, req.body);
    if (b.rowVersion == null) throw fieldError('rowVersion', 'Versão do registro obrigatória.');
    await findSterilizer(db, auth, id);
    return saveSterilizer(auth, actorOf(req), id, b);
  });

  /* ---------- Instrument set catalog ---------- */

  const setDto = (s: { id: string; code: string; name: string; specialty: string | null; composition: string | null; item_count: number | null; packaging: InstrumentSetDto['packaging']; implant: boolean; active: boolean; row_version: number }): InstrumentSetDto => ({
    id: s.id, code: s.code, name: s.name, specialty: s.specialty, composition: s.composition, itemCount: s.item_count, packaging: s.packaging, implant: s.implant, active: s.active, rowVersion: s.row_version,
  });

  app.get('/cme/sets', view, async (req) => {
    const auth = requireAuth(req);
    return { sets: (await db.selectFrom('instrument_set').selectAll().where('institution_id', '=', auth.institutionId).orderBy('name').execute()).map(setDto) };
  });

  const saveSet = async (auth: AuthContext, actor: ReturnType<typeof actorOf>, id: string | null, b: z.infer<typeof SetBody>) => {
    const values = { code: b.code, name: b.name, specialty: b.specialty, composition: b.composition, item_count: b.itemCount, packaging: b.packaging, implant: b.implant, active: b.active, updated_at: new Date() };
    return db.transaction().execute(async (trx) => {
      const dup = await trx.selectFrom('instrument_set').select('id').where('institution_id', '=', auth.institutionId).where('code', '=', b.code).executeTakeFirst();
      if (dup && dup.id !== id) throw fieldError('code', 'Já existe uma caixa com este código.');
      if (!id) {
        const created = await trx.insertInto('instrument_set').values({ institution_id: auth.institutionId, ...values }).returningAll().executeTakeFirstOrThrow();
        await audit(trx, actor, { action: 'create', entity: 'instrument_set', entityId: created.id, after: created, context: { justification: b.justification } });
        return { id: created.id, rowVersion: created.row_version };
      }
      const before = await trx.selectFrom('instrument_set').selectAll().where('id', '=', id).where('institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst();
      if (!before) throw notFound('Caixa');
      if (before.row_version !== b.rowVersion) throw conflict();
      const after = await trx.updateTable('instrument_set').set({ ...values, row_version: before.row_version + 1 }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actor, { action: 'update', entity: 'instrument_set', entityId: id, before, after, context: { justification: b.justification } });
      return { id, rowVersion: after.row_version };
    });
  };

  app.post('/cme/sets', configure, async (req, reply) => {
    const b = parse(SetBody, req.body);
    reply.code(201);
    return saveSet(requireAuth(req), actorOf(req), null, b);
  });

  app.put<{ Params: { id: string } }>('/cme/sets/:id', configure, async (req) => {
    const b = parse(SetBody, req.body);
    if (b.rowVersion == null) throw fieldError('rowVersion', 'Versão do registro obrigatória.');
    return saveSet(requireAuth(req), actorOf(req), parse(Uuid, req.params.id), b);
  });

  /* ---------- Loads (one per cycle run) ---------- */

  app.get('/cme/loads', view, async (req): Promise<Paged<LoadSummary>> => {
    const auth = requireAuth(req);
    const q = parse(LoadQuery, req.query);
    const { tz } = await context(db, auth.institutionId);
    let list = db.selectFrom('sterilization_load as l').innerJoin('sterilizer as s', 's.id', 'l.sterilizer_id').where('l.institution_id', '=', auth.institutionId);
    const scope = scopeOf(auth);
    if (scope) list = list.where('s.sector_id', 'in', scope);
    if (q.status === 'pendentes') list = list.where('l.status', 'in', ['aguardando', 'retida']);
    else if (q.status) list = list.where('l.status', '=', q.status);
    if (q.sterilizerId) list = list.where('l.sterilizer_id', '=', q.sterilizerId);
    if (q.from) list = list.where('l.started_at', '>=', zonedInstant(q.from, 0, tz));
    if (q.to) list = list.where('l.started_at', '<', zonedInstant(addDays(q.to, 1), 0, tz));
    if (q.q) list = list.where('l.code', 'ilike', `${escapeLike(q.q)}%`);
    const [ids, total] = await Promise.all([
      list.select('l.id').orderBy('l.started_at', 'desc').limit(q.pageSize).offset((q.page - 1) * q.pageSize).execute(),
      list.select((e) => e.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { rows: await loadSummaries(db, auth, ids.map((r) => r.id)), total: Number(total.n), page: q.page, pageSize: q.pageSize };
  });

  app.get<{ Params: { id: string } }>('/cme/loads/:id', view, async (req): Promise<LoadDetail> => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const l = await findLoad(db, auth, id);
    const { tz } = await context(db, auth.institutionId);
    const { policy, snapshot } = await loadPolicy(db, auth.institutionId);
    const [summary] = await loadSummaries(db, auth, [id]);
    const ev = (await evaluateLoads(db, auth.institutionId, [id], tz, policy)).get(id)!;
    const [items, decisions, next, exposure] = await Promise.all([
      db.selectFrom('load_item as i').leftJoin('instrument_set as k', 'k.id', 'i.set_id').selectAll('i').select('k.code as set_code').where('i.load_id', '=', id).orderBy('i.position').execute(),
      db.selectFrom('load_release_decision').selectAll().where('load_id', '=', id).orderBy('decided_at').execute(),
      db.selectFrom('sterilization_load').select('id').where('reprocessed_from_id', '=', id).executeTakeFirst(),
      db.selectFrom('material_use as u').innerJoin('load_item as i', 'i.id', 'u.item_id').innerJoin('surgery as s', 's.id', 'u.surgery_id').innerJoin('admission as a', 'a.id', 's.admission_id')
        .select((e) => [e.fn.count<string>('u.surgery_id').distinct().as('surgeries'), e.fn.count<string>('a.patient_id').distinct().as('patients')])
        .where('i.load_id', '=', id).where('u.voided_at', 'is', null).executeTakeFirstOrThrow(),
    ]);
    const uses = items.length ? await db.selectFrom('material_use').select(['id', 'item_id', 'used_at', 'sector_id', 'surgery_id', 'recorded_by_name']).where('item_id', 'in', items.map((i) => i.id)).where('voided_at', 'is', null).execute() : [];
    const useMap = await materialUseDtos(db, auth, uses);
    const tests = await testDtos(db, [...ev.tests, ...(ev.equipmentBowieDick ? [ev.equipmentBowieDick] : [])]);
    return {
      ...summary!, operatorName: l.operator_name, temperatureC: l.temperature_c == null ? null : Number(l.temperature_c), pressureKpa: l.pressure_kpa == null ? null : Number(l.pressure_kpa),
      exposureMinutes: l.exposure_minutes, notes: l.notes, rowVersion: l.row_version, evaluation: ev.evaluation, policy: snapshot, bowieDickApplies: ev.bowieDickApplies,
      equipmentBowieDick: ev.equipmentBowieDick ? tests.find((t) => t.id === ev.equipmentBowieDick!.id)! : null,
      tests: tests.filter((t) => t.loadId === id),
      itemList: items.map((i) => ({ id: i.id, position: i.position, labelCode: i.label_code, setId: i.set_id, setCode: i.set_code, description: i.description, quantity: i.quantity, packaging: i.packaging, implant: i.implant, expiresOn: i.expires_on, use: useMap.get(i.id) ?? null, processId: i.process_id })),
      decisions: decisions.map((d) => ({ id: d.id, from: d.from_status, to: d.to_status, at: d.decided_at.toISOString(), by: d.decided_by_name, justification: d.justification, policy: d.policy_snapshot as LoadDetail['policy'], evaluation: d.evaluation as LoadDetail['evaluation'] })),
      exposed: { surgeries: Number(exposure.surgeries), patients: Number(exposure.patients) }, reprocessedIntoId: next?.id ?? null,
    };
  });

  app.post('/cme/loads', cycle, async (req, reply) => {
    const auth = requireAuth(req);
    const b = parse(LoadCreate, req.body);
    const st = await findSterilizer(db, auth, b.sterilizerId);
    if (st.status !== 'ativo') throw fieldError('sterilizerId', `Equipamento ${st.status === 'manutencao' ? 'em manutenção (bloqueado)' : 'inativo'}: não pode iniciar ciclos.`);
    const { tz, rules } = await context(db, auth.institutionId);
    const setIds = [...new Set(b.items.map((i) => i.setId).filter((s): s is string => !!s))];
    const sets = setIds.length ? await db.selectFrom('instrument_set').selectAll().where('institution_id', '=', auth.institutionId).where('id', 'in', setIds).execute() : [];
    const items = b.items.map((it, idx) => {
      const set = it.setId ? sets.find((s) => s.id === it.setId) : undefined;
      if (it.setId && (!set || !set.active)) throw fieldError(`items.${idx}.setId`, 'Caixa inexistente ou inativa.');
      const description = set ? set.name : it.description;
      if (!description) throw fieldError(`items.${idx}.description`, 'Descreva o material avulso.');
      const packaging = it.packaging ?? set?.packaging;
      if (!packaging) throw fieldError(`items.${idx}.packaging`, 'Informe a embalagem.');
      return { setId: set?.id ?? null, description, quantity: it.quantity, packaging, implant: it.implant ?? set?.implant ?? false };
    });
    const day = dateInZone(b.startedAt ?? new Date(), tz);
    const expiresOn = sterileUntil(day, rules.cme.shelfLifeDays?.value);
    const origin = await institutionOrigin(db, auth.institutionId);
    const created = await db.transaction().execute(async (trx) => {
      // One code sequence per sterilizer and day.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`load:${st.id}`}))`.execute(trx);
      if (b.reprocessedFromId) {
        const src = await trx.selectFrom('sterilization_load').select(['status', 'institution_id']).where('id', '=', b.reprocessedFromId).forUpdate().executeTakeFirst();
        if (!src || src.institution_id !== auth.institutionId) throw fieldError('reprocessedFromId', 'Carga de origem inexistente.');
        if (src.status !== 'reprocessamento' && src.status !== 'rejeitada') throw fieldError('reprocessedFromId', 'Só cargas rejeitadas ou enviadas para reprocessamento podem ser reprocessadas.');
        if (await trx.selectFrom('sterilization_load').select('id').where('reprocessed_from_id', '=', b.reprocessedFromId).executeTakeFirst()) throw fieldError('reprocessedFromId', 'Esta carga já foi reprocessada.');
      }
      // Next sequence of this sterilizer and day, read from the codes (loads in assembly have no start yet).
      const prefix = loadCode(st.code, day, 0).slice(0, -2);
      const last = await trx.selectFrom('sterilization_load').select('code').where('institution_id', '=', auth.institutionId).where('code', 'like', `${prefix}%`).orderBy('code', 'desc').limit(1).executeTakeFirst();
      const code = loadCode(st.code, day, (last ? Number(last.code.slice(-2)) : 0) + 1);
      const load = await trx.insertInto('sterilization_load').values({
        institution_id: auth.institutionId, sterilizer_id: st.id, code, program: b.program, started_at: b.startedAt, operator_id: auth.userId, operator_name: auth.displayName,
        notes: b.notes, has_implant: items.some((i) => i.implant), reprocessed_from_id: b.reprocessedFromId, data_origin: origin,
      }).returningAll().executeTakeFirstOrThrow();
      if (items.length) await trx.insertInto('load_item').values(items.map((i, idx) => ({
        institution_id: auth.institutionId, load_id: load.id, position: idx + 1, label_code: itemLabel(code, idx + 1), set_id: i.setId, description: i.description,
        quantity: i.quantity, packaging: i.packaging, implant: i.implant, expires_on: expiresOn,
      }))).execute();
      await trx.insertInto('load_release_decision').values({ load_id: load.id, from_status: null, to_status: 'aguardando', decided_by: auth.userId, decided_by_name: auth.displayName, justification: 'Carga registrada.', policy_snapshot: null, evaluation: JSON.stringify({ status: 'aguardando', reasons: [] }) }).execute();
      await audit(trx, actorOf(req), { action: 'create', entity: 'sterilization_load', entityId: load.id, after: { ...load, items: items.length } });
      return load;
    });
    reply.code(201);
    return { id: created.id, code: created.code };
  });

  /** Start of the cycle of a load assembled by reading (its packages are then fixed). */
  app.post<{ Params: { id: string } }>('/cme/loads/:id/start', cycle, async (req) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(CycleStart, req.body);
    const l = await findLoad(db, auth, id);
    if (l.started_at) throw new HttpError(409, 'ciclo_iniciado', 'O ciclo desta carga já foi iniciado.');
    if (b.startedAt.getTime() < l.created_at.getTime() - 60_000) throw fieldError('startedAt', 'O início não pode ser anterior à montagem da carga.');
    return db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('sterilization_load').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
      if (before.row_version !== b.rowVersion) throw conflict();
      const st = await trx.selectFrom('sterilizer').select('status').where('id', '=', before.sterilizer_id).executeTakeFirstOrThrow();
      if (st.status !== 'ativo') throw fieldError('startedAt', 'Equipamento bloqueado ou inativo: o ciclo não pode começar.');
      const packages = Number((await trx.selectFrom('load_item').select((e) => e.fn.countAll<string>().as('n')).where('load_id', '=', id).executeTakeFirstOrThrow()).n);
      if (!packages) throw fieldError('startedAt', 'Carga sem pacotes: leia os pacotes na estação de montagem.');
      const after = await trx.updateTable('sterilization_load').set({ started_at: b.startedAt, updated_at: new Date(), row_version: before.row_version + 1 }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'update', entity: 'sterilization_load', entityId: id, before, after, context: { step: 'inicio_do_ciclo', packages } });
      return { ok: true, rowVersion: after.row_version };
    });
  });

  app.post<{ Params: { id: string } }>('/cme/loads/:id/cycle', cycle, async (req) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(CycleFinish, req.body);
    const l = await findLoad(db, auth, id);
    if (l.ended_at) throw new HttpError(409, 'ciclo_encerrado', 'O ciclo desta carga já foi encerrado.');
    if (!l.started_at) throw new HttpError(409, 'ciclo_nao_iniciado', 'Inicie o ciclo antes de encerrá-lo.');
    if (b.endedAt <= l.started_at) throw fieldError('endedAt', 'O término deve ser depois do início do ciclo.');
    return db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('sterilization_load').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
      if (before.row_version !== b.rowVersion) throw conflict();
      const after = await trx.updateTable('sterilization_load').set({
        ended_at: b.endedAt, temperature_c: b.temperatureC, pressure_kpa: b.pressureKpa, exposure_minutes: b.exposureMinutes, physical_result: b.physicalResult,
        notes: b.notes ?? before.notes, updated_at: new Date(), row_version: before.row_version + 1,
      }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'update', entity: 'sterilization_load', entityId: id, before, after, context: { step: 'fim_do_ciclo' } });
      return { ok: true, rowVersion: after.row_version };
    });
  });

  app.post<{ Params: { id: string } }>('/cme/loads/:id/decision', release, async (req) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(Decision, req.body);
    await findLoad(db, auth, id);
    const { tz } = await context(db, auth.institutionId);
    return db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('sterilization_load').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
      if (before.row_version !== b.rowVersion) throw conflict();
      // Evaluated inside the transaction, with the policy in force now.
      const { policy, snapshot } = await loadPolicy(trx, auth.institutionId);
      const ev = (await evaluateLoads(trx, auth.institutionId, [id], tz, policy)).get(id)!;
      const problems = checkLoadDecision(before.status, b.status, ev.evaluation, b.justification);
      if (problems.length) throw problemsError(problems);
      const after = await trx.updateTable('sterilization_load').set({ status: b.status, updated_at: new Date(), row_version: before.row_version + 1 }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      const decision = await trx.insertInto('load_release_decision').values({
        load_id: id, from_status: before.status, to_status: b.status, decided_by: auth.userId, decided_by_name: auth.displayName, justification: b.justification,
        policy_snapshot: snapshot ? JSON.stringify(snapshot) : null, evaluation: JSON.stringify({ status: ev.evaluation.status, reasons: ev.evaluation.reasons }),
      }).returning('id').executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'status_change', entity: 'sterilization_load', entityId: id, before: { status: before.status }, after: { status: b.status }, context: { justification: b.justification, decisionId: decision.id, policyVersion: snapshot?.version ?? null, evaluation: ev.evaluation.status } });
      return { ok: true, rowVersion: after.row_version };
    });
  });

  /* ---------- Tests ---------- */

  app.get('/cme/bowie-dick', view, async (req) => {
    const auth = requireAuth(req);
    const q = parse(z.object({ from: IsoDate, to: IsoDate }).strict(), req.query);
    if (q.from > q.to) throw fieldError('from', 'Período inválido.');
    let list = db.selectFrom('sterilization_test as t').innerJoin('sterilizer as s', 's.id', 't.sterilizer_id').selectAll('t')
      .where('t.institution_id', '=', auth.institutionId).where('t.type', '=', 'BOWIE_DICK').where('t.performed_on', '>=', q.from).where('t.performed_on', '<=', q.to);
    const scope = scopeOf(auth);
    if (scope) list = list.where('s.sector_id', 'in', scope);
    return { tests: await testDtos(db, await list.orderBy('t.performed_at').limit(2000).execute()) };
  });

  app.post('/cme/tests', tests, async (req, reply) => {
    const auth = requireAuth(req);
    const b = parse(TestCreate, req.body);
    const { tz } = await context(db, auth.institutionId);
    let sterilizerId: string;
    if (b.type === 'BOWIE_DICK') {
      if (!b.sterilizerId || b.loadId) throw fieldError('sterilizerId', 'Bowie-Dick é registrado por equipamento, sem carga.');
      sterilizerId = b.sterilizerId;
    } else {
      if (!b.loadId) throw fieldError('loadId', 'Indicadores químicos e biológicos são registrados na carga.');
      const l = await findLoad(db, auth, b.loadId);
      sterilizerId = l.sterilizer_id;
      const existing = await db.selectFrom('sterilization_test').select(['id', 'replaces_id']).where('load_id', '=', b.loadId).where('type', '=', b.type).execute();
      if (existing.length && currentOnly([...existing, ...(await db.selectFrom('sterilization_test').select(['id', 'replaces_id']).where('replaces_id', 'in', existing.map((e) => e.id)).execute())]).length) {
        throw new HttpError(409, 'teste_existente', 'Este teste já foi registrado na carga. Registre a leitura ou uma correção no teste existente.');
      }
    }
    const st = await findSterilizer(db, auth, sterilizerId);
    const performedOn = dateInZone(b.performedAt, tz);
    const problems = checkTestRecord({
      type: b.type, result: b.result, performedOn, indicatorLot: b.indicatorLot || null, indicatorExpiry: b.indicatorExpiry,
      incubationStart: b.incubationStart?.toISOString() ?? null, readAt: b.readAt?.toISOString() ?? null, controlResult: b.controlResult, sterilizerType: st.type,
    });
    if (problems.length) throw problemsError(problems);
    const origin = await institutionOrigin(db, auth.institutionId);
    const row = await db.transaction().execute(async (trx) => {
      const created = await trx.insertInto('sterilization_test').values({
        institution_id: auth.institutionId, sterilizer_id: sterilizerId, load_id: b.type === 'BOWIE_DICK' ? null : b.loadId, type: b.type, result: b.result,
        performed_at: b.performedAt, performed_on: performedOn, indicator_lot: b.indicatorLot, indicator_expiry: b.indicatorExpiry!, incubation_start: b.type === 'IB' ? b.incubationStart : null,
        read_at: b.type === 'IB' ? b.readAt : null, control_result: b.type === 'IB' ? b.controlResult : null, notes: b.notes, recorded_by: auth.userId, recorded_by_name: auth.displayName,
        replaces_id: null, justification: null, data_origin: origin,
      }).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'create', entity: 'sterilization_test', entityId: created.id, after: created });
      return created;
    });
    reply.code(201);
    return { id: row.id };
  });

  app.post<{ Params: { id: string } }>('/cme/tests/:id/replace', tests, async (req, reply) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(TestReplace, req.body);
    const original = await db.selectFrom('sterilization_test').selectAll().where('id', '=', id).where('institution_id', '=', auth.institutionId).executeTakeFirst();
    if (!original) throw notFound('Teste');
    const st = await findSterilizer(db, auth, original.sterilizer_id);
    const reading = original.result === 'pendente';
    const justification = b.justification?.trim() || (reading ? 'Leitura do indicador biológico.' : '');
    if (justification.length < 10) throw fieldError('justification', 'Descreva o motivo da correção (mínimo 10 caracteres).');
    const problems = checkTestRecord({
      type: original.type, result: b.result, performedOn: original.performed_on, indicatorLot: original.indicator_lot, indicatorExpiry: original.indicator_expiry,
      incubationStart: original.incubation_start?.toISOString() ?? null, readAt: b.readAt?.toISOString() ?? null, controlResult: b.controlResult, sterilizerType: st.type,
    });
    if (problems.length) throw problemsError(problems);
    const row = await db.transaction().execute(async (trx) => {
      // The unique replaces_id makes a concurrent second correction fail instead of forking the history.
      if (await trx.selectFrom('sterilization_test').select('id').where('replaces_id', '=', id).executeTakeFirst()) throw conflict();
      const created = await trx.insertInto('sterilization_test').values({
        institution_id: auth.institutionId, sterilizer_id: original.sterilizer_id, load_id: original.load_id, type: original.type, result: b.result, performed_at: original.performed_at,
        performed_on: original.performed_on, indicator_lot: original.indicator_lot, indicator_expiry: original.indicator_expiry, incubation_start: original.incubation_start,
        read_at: original.type === 'IB' ? b.readAt : null, control_result: original.type === 'IB' ? b.controlResult : null, notes: b.notes ?? original.notes,
        recorded_by: auth.userId, recorded_by_name: auth.displayName, replaces_id: id, justification, data_origin: original.data_origin,
      }).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: reading ? 'create' : 'update', entity: 'sterilization_test', entityId: created.id, before: original, after: created, context: { justification, replaces: id } });
      return created;
    });
    reply.code(201);
    return { id: row.id };
  });

  /* ---------- Use of packages and traceability ---------- */

  const recordUse = async (req: Parameters<typeof actorOf>[0], auth: AuthContext, labelCode: string, usedAt: Date, sectorId: string, surgeryId: string | null) => {
    const { tz } = await context(db, auth.institutionId);
    const item = await findItemByLabel(db, auth, labelCode);
    const problems = checkItemUse({ loadStatus: item.status, expiresOn: item.expires_on, alreadyUsed: item.alreadyUsed }, dateInZone(usedAt, tz));
    if (problems.length) throw problemsError(problems);
    // Packages tracked by the flow should have left the CME. A missing exit never blocks the use
    // (institutional decision): it opens a non-conformity and notifies the user who recorded the use.
    const process = item.process_id ? await db.selectFrom('cme_process').select(['id', 'state', 'row_version']).where('id', '=', item.process_id).executeTakeFirst() : null;
    const withoutExit = !!process && process.state !== 'distribuido';
    const origin = await institutionOrigin(db, auth.institutionId);
    try {
      return await db.transaction().execute(async (trx) => {
        const created = await trx.insertInto('material_use').values({ institution_id: auth.institutionId, item_id: item.id, surgery_id: surgeryId, sector_id: sectorId, used_at: usedAt, recorded_by: auth.userId, recorded_by_name: auth.displayName, data_origin: origin }).returningAll().executeTakeFirstOrThrow();
        // The package is out of the CME now; when it comes back dirty, the reception opens a new round.
        let nonconformityId: string | null = null;
        if (withoutExit) {
          await trx.updateTable('cme_process').set({ state: 'distribuido', next_steps: ['devolucao'], destination_sector_id: sectorId, updated_at: new Date(), row_version: process.row_version + 1 }).where('id', '=', process.id).execute();
          const sector = await trx.selectFrom('sector').select('name').where('id', '=', sectorId).executeTakeFirstOrThrow();
          const nc = await openUseWithoutExitNc(trx, auth, { useId: created.id, labelCode: item.label_code, description: item.description, sectorId, sectorName: sector.name, usedOn: dateInZone(usedAt, tz), origin });
          nonconformityId = nc.id;
          await audit(trx, actorOf(req), { action: 'create', entity: 'nonconformity', entityId: nc.id, after: nc, context: { rule: 'cme_uso_sem_saida', materialUse: created.id, notifiedUser: auth.userId } });
        }
        await audit(trx, actorOf(req), { action: 'create', entity: 'material_use', entityId: created.id, after: { ...created, labelCode: item.label_code, load: item.code } });
        return { id: created.id, withoutExit, nonconformityId };
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw fieldError('labelCode', 'Material já utilizado: precisa ser reprocessado antes de novo uso.');
      throw e;
    }
  };

  app.post<{ Params: { id: string } }>('/surgeries/:id/materials', { preHandler: requirePermission(db, 'surgery:edit') }, async (req, reply) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(UseCreate, req.body);
    const found = (await surgerySummaries(db, { institutionId: auth.institutionId, scope: auth.scope, ids: [id] })).rows[0];
    if (!found) throw notFound('Cirurgia');
    const s = found.summary;
    const usedAt = b.usedAt ?? new Date(s.startedAt);
    if (usedAt.getTime() < Date.parse(s.startedAt) - 12 * 3_600_000) throw fieldError('usedAt', 'O uso não pode ser muito anterior ao início da cirurgia.');
    reply.code(201);
    return recordUse(req, auth, b.labelCode, usedAt, s.sectorId, id);
  });

  app.post('/cme/uses', cycle, async (req, reply) => {
    const auth = requireAuth(req);
    const b = parse(LooseUse, req.body);
    const sector = await db.selectFrom('sector').select('id').where('id', '=', b.sectorId).where('institution_id', '=', auth.institutionId).where('active', '=', true).executeTakeFirst();
    if (!sector) throw fieldError('sectorId', 'Setor inexistente.');
    reply.code(201);
    return recordUse(req, auth, b.labelCode, b.usedAt, b.sectorId, null);
  });

  app.post<{ Params: { id: string } }>('/material-uses/:id/void', { preHandler: requirePermission(db, 'surgery:edit', 'cme:cycle:record') }, async (req) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(VoidBody, req.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('material_use').selectAll().where('id', '=', id).where('institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst();
      if (!before) throw notFound('Registro de uso');
      // Linked to a surgery: only who records surgeries may undo it; loose use: the CME.
      if (before.surgery_id ? !auth.permissions.includes('surgery:edit') : !auth.permissions.includes('cme:cycle:record')) throw new HttpError(403, 'sem_permissao', 'Seu perfil não tem permissão para esta ação.');
      if (before.surgery_id && !(await surgerySummaries(trx, { institutionId: auth.institutionId, scope: auth.scope, ids: [before.surgery_id] })).rows.length) throw notFound('Registro de uso');
      if (before.voided_at) throw new HttpError(409, 'ja_anulado', 'Este registro já foi anulado.');
      const after = await trx.updateTable('material_use').set({ voided_at: new Date(), voided_by_name: auth.displayName, void_reason: b.justification }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'update', entity: 'material_use', entityId: id, before, after, context: { justification: b.justification, step: 'anulacao' } });
      return { ok: true };
    });
  });

  app.get('/cme/trace', view, async (req): Promise<TraceResult> => {
    const auth = requireAuth(req);
    const { q } = parse(z.object({ q: z.string().trim().min(3, 'Informe ao menos 3 caracteres.').max(60) }).strict(), req.query);
    const term = q.toUpperCase();
    const like = `${escapeLike(term)}%`;
    const [items, loads, sets, patients] = await Promise.all([
      db.selectFrom('load_item').select('id').where('institution_id', '=', auth.institutionId).where('label_code', 'like', like).limit(200).execute(),
      db.selectFrom('sterilization_load').select('id').where('institution_id', '=', auth.institutionId).where('code', 'like', like).limit(50).execute(),
      db.selectFrom('load_item as i').innerJoin('instrument_set as k', 'k.id', 'i.set_id').select('i.id').where('i.institution_id', '=', auth.institutionId).where('k.code', '=', q.toLowerCase()).limit(200).execute(),
      // Backward search by medical record: only for profiles that may see patients, within their scope.
      auth.permissions.includes('patient:view')
        ? db.selectFrom('material_use as u').innerJoin('surgery as s', 's.id', 'u.surgery_id').innerJoin('admission as a', 'a.id', 's.admission_id').innerJoin('patient as p', 'p.id', 'a.patient_id')
          .select(['u.item_id', 's.sector_id']).where('p.institution_id', '=', auth.institutionId).where('p.record_number', '=', q).where('u.voided_at', 'is', null).limit(200).execute()
        : Promise.resolve([]),
    ]);
    const patientItems = patients.filter((p) => !auth.scope || auth.scope.includes(p.sector_id)).map((p) => p.item_id);
    const itemIds = [...new Set([...items.map((i) => i.id), ...sets.map((i) => i.id), ...patientItems])];
    const fromItems = itemIds.length ? await traceRows(db, auth, { itemIds, limit: 200 }) : { rows: [], truncated: false };
    const fromLoads = loads.length ? await traceRows(db, auth, { loadIds: loads.map((l) => l.id), limit: 200 }) : { rows: [], truncated: false };
    const seen = new Set<string>();
    const rows = [...fromItems.rows, ...fromLoads.rows].filter((r) => (seen.has(r.itemId) ? false : (seen.add(r.itemId), true)));
    return { query: q, rows: rows.slice(0, 200), truncated: fromItems.truncated || fromLoads.truncated || rows.length > 200 };
  });
}
