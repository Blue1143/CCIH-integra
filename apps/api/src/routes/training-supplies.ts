import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  dailyConsumption, dateInZone, evaluateStock, requiredTrainings, rulesFromParameters, signedDelta, stockByLot, todayIn,
  type StaffMember, type SupplyDto, type SupplyMovementDto, type TrainingCoveragePayload, type TrainingDto, type TrainingSessionDto,
} from '@ccih/domain';
import type { DB } from '../db/types';
import { audit } from '../audit/audit';
import { actorOf, requireAuth, requirePermission, type AuthContext } from '../http/auth';
import { HttpError, conflict, notFound, parse } from '../http/errors';
import { Instant, IsoDate, Justification, OptionalText, RowVersion, Text, Uuid, notFuture } from '../http/schemas';
import { assertSector, institutionOrigin } from '../repositories/clinical';
import { attachmentsFor } from '../services/attachments';

const TrainingBody = z
  .object({
    title: Text(200), theme: Text(120), mandatory: z.boolean(), validityMonths: z.number().int().min(1).max(120).nullable(), targetJobRoleIds: z.array(Uuid).max(50),
    description: OptionalText(2000), active: z.boolean(), rowVersion: RowVersion.nullable(), justification: Justification,
  })
  .strict();
const SessionCreate = z
  .object({ heldOn: IsoDate, instructor: Text(160), hours: z.number().min(0.5).max(200), sectorId: Uuid.nullable(), notes: OptionalText(1000), attendees: z.array(z.object({ professionalId: Uuid, present: z.boolean(), score: z.number().min(0).max(100).nullable() }).strict()).min(1).max(500) })
  .strict();
const StaffCreate = z.object({ name: Text(160), registration: OptionalText(40), jobRoleId: Uuid, sectorId: Uuid, justification: Justification }).strict();
const SupplyBody = z
  .object({
    code: z.string().regex(/^[a-z0-9-]{2,40}$/, 'Use letras minúsculas, números e hífen.'), name: Text(200),
    category: z.enum(['preparacao_alcoolica', 'sabonete', 'epi', 'antisseptico', 'saneante', 'outro']), unit: Text(30),
    minCoverageDays: z.number().int().min(1).max(365).nullable(), active: z.boolean(), rowVersion: RowVersion.nullable(), justification: Justification,
  })
  .strict();
const MovementCreate = z
  .object({
    kind: z.enum(['entrada', 'consumo', 'ajuste', 'descarte']), lot: z.string().trim().regex(/^[A-Za-z0-9./-]{1,40}$/, 'Lote inválido.'), expiresOn: IsoDate.nullable(),
    quantity: z.number().finite().refine((v) => v !== 0, 'Quantidade não pode ser zero.'), sectorId: Uuid.nullable(), occurredAt: Instant, reason: OptionalText(300),
  })
  .strict();

const fieldError = (path: string, message: string) => new HttpError(400, 'validacao', message, [{ path, message }]);

async function context(db: Kysely<DB>, institutionId: string) {
  const [inst, params] = await Promise.all([
    db.selectFrom('institution').select('timezone').where('id', '=', institutionId).executeTakeFirstOrThrow(),
    db.selectFrom('rule_parameter').select(['key', 'value', 'reference_id']).where('institution_id', '=', institutionId).execute(),
  ]);
  return { tz: inst.timezone, today: todayIn(inst.timezone), rules: rulesFromParameters(params.map((p) => ({ key: p.key, value: p.value, referenceId: p.reference_id }))) };
}

/** Required trainings of the institution (scope applied by the caller). */
export async function loadRequiredTrainings(db: Kysely<DB>, institutionId: string, at: string, warningDays: number | undefined) {
  const [professionals, trainings, attendances] = await Promise.all([
    db.selectFrom('professional').select(['id', 'name', 'sector_id', 'job_role_id', 'active']).where('institution_id', '=', institutionId).execute(),
    db.selectFrom('training').selectAll().where('institution_id', '=', institutionId).where('active', '=', true).execute(),
    db.selectFrom('training_attendance as a').innerJoin('training_session as s', 's.id', 'a.session_id').innerJoin('training as t', 't.id', 's.training_id')
      .select(['s.training_id', 'a.professional_id', 's.held_on', 'a.present']).where('t.institution_id', '=', institutionId).execute(),
  ]);
  const rows = requiredTrainings({
    at, warningDays,
    professionals: professionals.map((p) => ({ id: p.id, sectorId: p.sector_id, jobRoleId: p.job_role_id, active: p.active })),
    trainings: trainings.map((t) => ({ id: t.id, mandatory: t.mandatory, validityMonths: t.validity_months, targetJobRoleIds: t.target_job_role_ids })),
    attendances: attendances.map((a) => ({ trainingId: a.training_id, professionalId: a.professional_id, heldOn: a.held_on, present: a.present })),
  });
  return { rows, professionals, trainings };
}

const visible = (auth: AuthContext, sectorId: string | null) => !auth.scope || (sectorId != null && auth.scope.includes(sectorId));

/** Current stock of every supply, with the institutional coverage and expiry evaluation. */
export async function loadSupplies(db: Kysely<DB>, institutionId: string, today: string, tz: string, rules: { defaultMinCoverageDays: number | undefined; expiryWarningDays: number | undefined }): Promise<SupplyDto[]> {
  const [supplies, lots, movements] = await Promise.all([
    db.selectFrom('supply').selectAll().where('institution_id', '=', institutionId).orderBy('name').execute(),
    db.selectFrom('supply_lot').innerJoin('supply', 'supply.id', 'supply_lot.supply_id').selectAll('supply_lot').where('supply.institution_id', '=', institutionId).execute(),
    db.selectFrom('supply_movement as m').innerJoin('supply_lot as l', 'l.id', 'm.lot_id').innerJoin('supply as s', 's.id', 'l.supply_id')
      .select(['m.lot_id', 'm.kind', 'm.delta', 'm.occurred_at', 'l.supply_id']).where('s.institution_id', '=', institutionId).execute(),
  ]);
  return supplies.map((s) => {
    const mine = movements.filter((m) => m.supply_id === s.id).map((m) => ({ lotId: m.lot_id, kind: m.kind, delta: Number(m.delta), occurredOn: dateInZone(m.occurred_at, tz) }));
    const stock = stockByLot(mine);
    const myLots = lots.filter((l) => l.supply_id === s.id).map((l) => ({ id: l.id, lot: l.lot, expiresOn: l.expires_on, quantity: Math.round((stock.get(l.id) ?? 0) * 100) / 100 }));
    const positive = myLots.filter((l) => l.quantity > 0);
    const quantity = positive.reduce((t, l) => t + l.quantity, 0);
    const daily = dailyConsumption(mine, today);
    // Expiry of the stock that will be used first (earliest expiring lot with balance).
    const expiresOn = positive.map((l) => l.expiresOn).filter((d): d is string => !!d).sort()[0] ?? null;
    return {
      id: s.id, code: s.code, name: s.name, category: s.category, unit: s.unit, minCoverageDays: s.min_coverage_days, active: s.active, rowVersion: s.row_version,
      quantity: Math.round(quantity * 100) / 100, dailyConsumption: daily, lots: myLots.sort((a, b) => (a.expiresOn ?? '9999').localeCompare(b.expiresOn ?? '9999')),
      evaluation: evaluateStock({ quantity, dailyConsumption: daily, minCoverageDays: s.min_coverage_days, expiresOn }, rules, today),
    };
  });
}

export async function trainingSupplyRoutes(app: FastifyInstance, { db }: { db: Kysely<DB> }) {
  const view = { preHandler: requirePermission(db, 'quality:view') };
  const training = { preHandler: requirePermission(db, 'quality:training:edit') };
  const supplies = { preHandler: requirePermission(db, 'quality:supplies:edit') };
  const configure = { preHandler: requirePermission(db, 'quality:configure') };

  /* ---------- Staff (professionals with job role and sector) ---------- */

  app.get('/staff', view, async (req): Promise<{ staff: StaffMember[]; jobRoles: Array<{ id: string; name: string }> }> => {
    const auth = requireAuth(req);
    const [rows, roles] = await Promise.all([
      db.selectFrom('professional').leftJoin('job_role', 'job_role.id', 'professional.job_role_id').select(['professional.id', 'professional.name', 'professional.job_role_id', 'job_role.name as job', 'professional.sector_id', 'professional.active']).where('professional.institution_id', '=', auth.institutionId).orderBy('professional.name').execute(),
      db.selectFrom('job_role').select(['id', 'name']).where('institution_id', '=', auth.institutionId).orderBy('name').execute(),
    ]);
    return { staff: rows.filter((r) => visible(auth, r.sector_id)).map((r) => ({ id: r.id, name: r.name, jobRoleId: r.job_role_id, jobRole: r.job, sectorId: r.sector_id, active: r.active })), jobRoles: roles };
  });

  app.post('/staff', configure, async (req, reply) => {
    const auth = requireAuth(req);
    const b = parse(StaffCreate, req.body);
    await assertSector(db, auth, b.sectorId);
    if (!(await db.selectFrom('job_role').select('id').where('id', '=', b.jobRoleId).where('institution_id', '=', auth.institutionId).executeTakeFirst())) throw fieldError('jobRoleId', 'Cargo inexistente.');
    const row = await db.transaction().execute(async (trx) => {
      const created = await trx.insertInto('professional').values({ institution_id: auth.institutionId, name: b.name, registration: b.registration, job_role_id: b.jobRoleId, sector_id: b.sectorId }).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'create', entity: 'professional', entityId: created.id, after: created, context: { justification: b.justification } });
      return created;
    });
    reply.code(201);
    return { id: row.id };
  });

  /* ---------- Trainings ---------- */

  app.get('/trainings', view, async (req): Promise<{ trainings: TrainingDto[]; sessions: TrainingSessionDto[] }> => {
    const auth = requireAuth(req);
    const { today, rules } = await context(db, auth.institutionId);
    const { rows, trainings } = await loadRequiredTrainings(db, auth.institutionId, today, rules.training.expiryWarningDays?.value);
    const mine = rows.filter((r) => visible(auth, r.sectorId));
    const sessions = await db.selectFrom('training_session as s').innerJoin('training as t', 't.id', 's.training_id')
      .select((eb) => ['s.id', 's.training_id', 's.held_on', 's.instructor', 's.hours', 's.sector_id', 's.notes', 's.data_origin',
        eb.selectFrom('training_attendance').select((e) => e.fn.countAll<string>().as('n')).whereRef('training_attendance.session_id', '=', 's.id').where('training_attendance.present', '=', true).as('attendees')])
      .where('t.institution_id', '=', auth.institutionId).orderBy('s.held_on', 'desc').limit(200).execute();
    const visibleSessions = sessions.filter((s) => !auth.scope || s.sector_id == null || auth.scope.includes(s.sector_id));
    const files = await attachmentsFor(db, 'training_session', visibleSessions.map((s) => s.id));
    return {
      trainings: trainings.map((t) => {
        const req_ = mine.filter((r) => r.trainingId === t.id);
        return {
          id: t.id, title: t.title, theme: t.theme, mandatory: t.mandatory, validityMonths: t.validity_months, targetJobRoleIds: t.target_job_role_ids, description: t.description,
          active: t.active, rowVersion: t.row_version, sessions: sessions.filter((s) => s.training_id === t.id).length, required: req_.length,
          covered: req_.filter((r) => r.state === 'valido' || r.state === 'vencendo').length, expiring: req_.filter((r) => r.state === 'vencendo').length, overdue: req_.filter((r) => r.state === 'vencido' || r.state === 'pendente').length,
        };
      }),
      sessions: visibleSessions.map((s) => ({ id: s.id, trainingId: s.training_id, heldOn: s.held_on, instructor: s.instructor, hours: Number(s.hours), sectorId: s.sector_id, notes: s.notes, attendees: Number(s.attendees ?? 0), origin: s.data_origin, attachments: files.get(s.id) ?? [] })),
    };
  });

  app.get('/trainings/coverage', view, async (req): Promise<TrainingCoveragePayload> => {
    const auth = requireAuth(req);
    const { today, rules } = await context(db, auth.institutionId);
    const { rows, professionals } = await loadRequiredTrainings(db, auth.institutionId, today, rules.training.expiryWarningDays?.value);
    const roles = await db.selectFrom('job_role').select(['id', 'name']).where('institution_id', '=', auth.institutionId).orderBy('name').execute();
    const names = new Map(professionals.map((p) => [p.id, p.name]));
    const mine = rows.filter((r) => visible(auth, r.sectorId));
    const agg = new Map<string, { sectorId: string; trainingId: string; required: number; covered: number }>();
    for (const r of mine) {
      if (!r.sectorId) continue;
      const k = `${r.sectorId}|${r.trainingId}`;
      const a = agg.get(k) ?? { sectorId: r.sectorId, trainingId: r.trainingId, required: 0, covered: 0 };
      a.required++;
      if (r.state === 'valido' || r.state === 'vencendo') a.covered++;
      agg.set(k, a);
    }
    return { rows: mine.map((r) => ({ ...r, professionalName: names.get(r.professionalId) ?? '—' })), bySector: [...agg.values()], jobRoles: roles };
  });

  app.put('/trainings', configure, async (req) => {
    const auth = requireAuth(req);
    const b = parse(TrainingBody.extend({ id: Uuid.nullable() }), req.body);
    if (b.targetJobRoleIds.length) {
      const valid = await db.selectFrom('job_role').select('id').where('institution_id', '=', auth.institutionId).where('id', 'in', b.targetJobRoleIds).execute();
      if (valid.length !== new Set(b.targetJobRoleIds).size) throw fieldError('targetJobRoleIds', 'Cargo inexistente.');
    }
    if (b.mandatory && !b.targetJobRoleIds.length) throw fieldError('targetJobRoleIds', 'Treinamento obrigatório precisa de público-alvo.');
    return db.transaction().execute(async (trx) => {
      const before = b.id ? await trx.selectFrom('training').selectAll().where('id', '=', b.id).where('institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst() : undefined;
      if (b.id && !before) throw notFound('Treinamento');
      if (before ? before.row_version !== b.rowVersion : b.rowVersion !== null) throw conflict();
      const dup = await trx.selectFrom('training').select('id').where('institution_id', '=', auth.institutionId).where('title', '=', b.title).executeTakeFirst();
      if (dup && dup.id !== b.id) throw new HttpError(409, 'duplicado', 'Já existe um treinamento com este título.', [{ path: 'title', message: 'Título já utilizado.' }]);
      const values = { title: b.title, theme: b.theme, mandatory: b.mandatory, validity_months: b.validityMonths, target_job_role_ids: [...new Set(b.targetJobRoleIds)], description: b.description, active: b.active, updated_at: new Date() };
      const after = before
        ? await trx.updateTable('training').set({ ...values, row_version: before.row_version + 1 }).where('id', '=', before.id).returningAll().executeTakeFirstOrThrow()
        : await trx.insertInto('training').values({ ...values, institution_id: auth.institutionId }).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: before ? 'update' : 'create', entity: 'training', entityId: after.id, before: before ?? null, after, context: { justification: b.justification } });
      return { ok: true, id: after.id, rowVersion: after.row_version };
    });
  });

  app.post<{ Params: { id: string } }>('/trainings/:id/sessions', training, async (req, reply) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(SessionCreate, req.body);
    const { today } = await context(db, auth.institutionId);
    if (b.heldOn > today) throw fieldError('heldOn', 'Registre a turma após a realização.');
    if (b.sectorId) await assertSector(db, auth, b.sectorId);
    const training = await db.selectFrom('training').select(['id', 'active']).where('id', '=', id).where('institution_id', '=', auth.institutionId).executeTakeFirst();
    if (!training?.active) throw notFound('Treinamento');
    const ids = [...new Set(b.attendees.map((a) => a.professionalId))];
    if (ids.length !== b.attendees.length) throw fieldError('attendees', 'Profissional repetido na lista.');
    const pros = await db.selectFrom('professional').select(['id', 'sector_id']).where('institution_id', '=', auth.institutionId).where('id', 'in', ids).execute();
    if (pros.length !== ids.length || pros.some((p) => !visible(auth, p.sector_id))) throw fieldError('attendees', 'Profissional inexistente ou fora do seu escopo.');
    const row = await db.transaction().execute(async (trx) => {
      const created = await trx.insertInto('training_session').values({ training_id: id, held_on: b.heldOn, instructor: b.instructor, hours: b.hours, sector_id: b.sectorId, notes: b.notes, data_origin: await institutionOrigin(trx, auth.institutionId), created_by: auth.userId }).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto('training_attendance').values(b.attendees.map((a) => ({ session_id: created.id, professional_id: a.professionalId, present: a.present, score: a.score }))).execute();
      await audit(trx, actorOf(req), { action: 'create', entity: 'training_session', entityId: created.id, after: { ...created, attendees: b.attendees } });
      return created;
    });
    reply.code(201);
    return { id: row.id };
  });

  /* ---------- Supplies ---------- */

  app.get('/supplies', view, async (req) => {
    const auth = requireAuth(req);
    const { today, tz, rules } = await context(db, auth.institutionId);
    return { supplies: await loadSupplies(db, auth.institutionId, today, tz, { defaultMinCoverageDays: rules.supplies.defaultMinCoverageDays?.value, expiryWarningDays: rules.supplies.expiryWarningDays?.value }) };
  });

  app.get<{ Params: { id: string } }>('/supplies/:id/movements', view, async (req): Promise<{ movements: SupplyMovementDto[] }> => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    // A supply of another organization does not exist for this user (404, not an empty list).
    if (!(await db.selectFrom('supply').select('id').where('id', '=', id).where('institution_id', '=', auth.institutionId).executeTakeFirst())) throw notFound('Insumo');
    const rows = await db.selectFrom('supply_movement as m').innerJoin('supply_lot as l', 'l.id', 'm.lot_id').innerJoin('supply as s', 's.id', 'l.supply_id')
      .select(['m.id', 'l.lot', 'm.kind', 'm.delta', 'm.sector_id', 'm.occurred_at', 'm.reason', 'm.created_by_name'])
      .where('s.id', '=', id).where('s.institution_id', '=', auth.institutionId).orderBy('m.occurred_at', 'desc').limit(200).execute();
    return { movements: rows.map((m) => ({ id: m.id, lot: m.lot, kind: m.kind, delta: Number(m.delta), sectorId: m.sector_id, occurredAt: m.occurred_at.toISOString(), reason: m.reason, by: m.created_by_name })) };
  });

  app.put('/supplies', configure, async (req) => {
    const auth = requireAuth(req);
    const b = parse(SupplyBody, req.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('supply').selectAll().where('institution_id', '=', auth.institutionId).where('code', '=', b.code).forUpdate().executeTakeFirst();
      if (before ? before.row_version !== b.rowVersion : b.rowVersion !== null) throw conflict();
      const values = { name: b.name, category: b.category, unit: b.unit, min_coverage_days: b.minCoverageDays, active: b.active, updated_at: new Date() };
      const after = before
        ? await trx.updateTable('supply').set({ ...values, row_version: before.row_version + 1 }).where('id', '=', before.id).returningAll().executeTakeFirstOrThrow()
        : await trx.insertInto('supply').values({ ...values, institution_id: auth.institutionId, code: b.code }).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: before ? 'update' : 'create', entity: 'supply', entityId: after.id, before: before ?? null, after, context: { justification: b.justification } });
      return { ok: true, id: after.id, rowVersion: after.row_version };
    });
  });

  /** Ledger entry: never edited; stock cannot go below zero; consumption is attributed to a sector. */
  app.post<{ Params: { id: string } }>('/supplies/:id/movements', supplies, async (req, reply) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(MovementCreate, req.body);
    if (!notFuture(b.occurredAt)) throw fieldError('occurredAt', 'O movimento não pode estar no futuro.');
    if (b.kind === 'consumo' && !b.sectorId) throw fieldError('sectorId', 'Informe o setor que consumiu.');
    if (b.sectorId) await assertSector(db, auth, b.sectorId);
    if ((b.kind === 'ajuste' || b.kind === 'descarte') && !b.reason) throw fieldError('reason', 'Informe o motivo do ajuste ou descarte.');
    if (b.kind !== 'ajuste' && b.quantity < 0) throw fieldError('quantity', 'Informe a quantidade positiva; o sentido vem do tipo de movimento.');
    const delta = signedDelta(b.kind, b.quantity);
    const row = await db.transaction().execute(async (trx) => {
      const supply = await trx.selectFrom('supply').select(['id', 'active']).where('id', '=', id).where('institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst();
      if (!supply) throw notFound('Insumo');
      let lot = await trx.selectFrom('supply_lot').selectAll().where('supply_id', '=', id).where('lot', '=', b.lot).executeTakeFirst();
      if (!lot) {
        if (b.kind !== 'entrada') throw fieldError('lot', 'Lote inexistente. Registre a entrada do lote primeiro.');
        if (!supply.active) throw fieldError('lot', 'Insumo inativo.');
        lot = await trx.insertInto('supply_lot').values({ supply_id: id, lot: b.lot, expires_on: b.expiresOn }).returningAll().executeTakeFirstOrThrow();
      } else if (b.kind === 'entrada' && b.expiresOn && lot.expires_on && b.expiresOn !== lot.expires_on) {
        throw fieldError('expiresOn', 'A validade informada difere da cadastrada para este lote.');
      }
      const balance = await trx.selectFrom('supply_movement').select((eb) => eb.fn.coalesce(eb.fn.sum<string>('delta'), eb.val('0')).as('q')).where('lot_id', '=', lot.id).executeTakeFirstOrThrow();
      if (Number(balance.q) + delta < 0) throw fieldError('quantity', `Saldo insuficiente no lote (${Number(balance.q)}).`);
      const created = await trx.insertInto('supply_movement').values({ lot_id: lot.id, kind: b.kind, delta, sector_id: b.sectorId, occurred_at: b.occurredAt, reason: b.reason, created_by: auth.userId, created_by_name: auth.displayName, data_origin: await institutionOrigin(trx, auth.institutionId) }).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'create', entity: 'supply_movement', entityId: created.id, after: { ...created, lot: b.lot } });
      return created;
    });
    reply.code(201);
    return { id: row.id };
  });
}
