import type { FastifyInstance } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import { INDICATORS, TEST_TYPE_LABEL, getRuleSpec, todayIn, validateRuleValue } from '@ccih/domain';
import type { DB } from '../db/types';
import { audit } from '../audit/audit';
import { actorOf, requireAuth, requirePermission } from '../http/auth';
import { HttpError, conflict, forbidden, notFound, parse } from '../http/errors';

const Uuid = z.string().uuid();
const RowVersion = z.number().int().min(1);
/** Why the change was made; stored in the audit log with the before/after values. */
const Justification = z.string().trim().min(10, 'Descreva o motivo (mínimo 10 caracteres).').max(500);

const TargetBody = z
  .object({
    value: z.number().finite(),
    warningBand: z.number().finite().min(0).nullable(),
    referenceId: Uuid.nullable(),
    rowVersion: RowVersion.nullable(),
    justification: Justification,
  })
  .strict();

/** rowVersion null = first configuration of a parameter that has no value yet (e.g. added by a later version). */
const RuleBody = z.object({ value: z.unknown(), referenceId: Uuid.nullable(), rowVersion: RowVersion.nullable(), justification: Justification }).strict();

const ReferenceFields = {
  title: z.string().trim().min(3).max(200),
  kind: z.enum(['regulatoria', 'diretriz', 'protocolo_institucional', 'literatura']),
  source: z.string().trim().min(3).max(300),
  version: z.string().trim().min(1).max(80),
  updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use AAAA-MM-DD.'),
  notes: z.string().trim().max(2000).nullable(),
};
const ReferenceCreate = z.object({ code: z.string().regex(/^[a-z0-9-]{3,60}$/, 'Use letras minúsculas, números e hífen.'), ...ReferenceFields, justification: Justification }).strict();
const ReferenceUpdate = z.object({ ...ReferenceFields, rowVersion: RowVersion, justification: Justification }).strict();
const ReferenceValidate = z.object({ status: z.enum(['vigente', 'revisao_necessaria', 'arquivado']), rowVersion: RowVersion, justification: Justification }).strict();

const TEST_TYPES = Object.keys(TEST_TYPE_LABEL) as [string, ...string[]];
const PolicyBody = z
  .object({
    requiredLoadTests: z.array(z.enum(TEST_TYPES)).max(9),
    requireDailyBowieDick: z.boolean(),
    holdImplantsUntilBiological: z.boolean(),
    referenceId: Uuid.nullable(),
    rowVersion: RowVersion,
    justification: Justification,
  })
  .strict();

async function assertReference(trx: Transaction<DB>, institutionId: string, id: string | null) {
  if (!id) return;
  const ok = await trx.selectFrom('clinical_reference').select('id').where('id', '=', id).where('institution_id', '=', institutionId).executeTakeFirst();
  if (!ok) throw new HttpError(400, 'validacao', 'Referência inexistente.', [{ path: 'referenceId', message: 'Referência inexistente.' }]);
}

export async function configRoutes(app: FastifyInstance, { db }: { db: Kysely<DB> }) {
  /* ---------- Targets ---------- */
  app.put<{ Params: { indicatorId: string } }>('/config/targets/:indicatorId', { preHandler: requirePermission(db, 'config:targets:edit') }, async (req) => {
    const auth = requireAuth(req);
    const def = INDICATORS.find((d) => d.id === req.params.indicatorId);
    if (!def) throw notFound('Indicador');
    const body = parse(TargetBody, req.body);
    return db.transaction().execute(async (trx) => {
      await assertReference(trx, auth.institutionId, body.referenceId);
      const before = await trx.selectFrom('indicator_target').selectAll().where('institution_id', '=', auth.institutionId).where('indicator_id', '=', def.id).forUpdate().executeTakeFirst();
      if (before ? before.row_version !== body.rowVersion : body.rowVersion !== null) throw conflict();
      const inst = await trx.selectFrom('institution').select('timezone').where('id', '=', auth.institutionId).executeTakeFirstOrThrow();
      const values = {
        value: body.value,
        // Direction comes from the catalog: a target cannot invert the meaning of an indicator.
        direction: def.direction,
        warning_band: body.warningBand,
        origin: 'institucional' as const,
        approved_by: auth.userId,
        approved_by_name: auth.displayName,
        valid_from: todayIn(inst.timezone),
        reference_id: body.referenceId,
        updated_at: new Date(),
      };
      const after = before
        ? await trx.updateTable('indicator_target').set({ ...values, row_version: before.row_version + 1 }).where('institution_id', '=', auth.institutionId).where('indicator_id', '=', def.id).returningAll().executeTakeFirstOrThrow()
        : await trx.insertInto('indicator_target').values({ ...values, institution_id: auth.institutionId, indicator_id: def.id }).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: before ? 'update' : 'create', entity: 'indicator_target', entityId: def.id, before: before ?? null, after, context: { justification: body.justification } });
      return { ok: true, rowVersion: after.row_version };
    });
  });

  app.delete<{ Params: { indicatorId: string } }>('/config/targets/:indicatorId', { preHandler: requirePermission(db, 'config:targets:edit') }, async (req) => {
    const auth = requireAuth(req);
    const { justification } = parse(z.object({ justification: Justification }).strict(), req.body ?? {});
    return db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('indicator_target').selectAll().where('institution_id', '=', auth.institutionId).where('indicator_id', '=', req.params.indicatorId).forUpdate().executeTakeFirst();
      if (!before) throw notFound('Meta');
      await trx.deleteFrom('indicator_target').where('institution_id', '=', auth.institutionId).where('indicator_id', '=', req.params.indicatorId).execute();
      await audit(trx, actorOf(req), { action: 'delete', entity: 'indicator_target', entityId: req.params.indicatorId, before, after: null, context: { justification } });
      return { ok: true };
    });
  });

  /* ---------- Rule parameters ---------- */
  app.put<{ Params: { key: string } }>('/config/rules/:key', { preHandler: requirePermission(db, 'config:rules:edit', 'cme:parameters:edit', 'ccih:parameters:edit') }, async (req) => {
    const auth = requireAuth(req);
    const spec = getRuleSpec(req.params.key);
    if (!spec) throw notFound('Parâmetro');
    // A module administrator edits only the parameters of its module.
    const needed = spec.group === 'cme' ? 'cme:parameters:edit' : 'ccih:parameters:edit';
    if (!auth.permissions.includes('config:rules:edit') && !auth.permissions.includes(needed)) {
      await audit(db, actorOf(req), { action: 'access_denied', entity: 'rule_parameter', entityId: spec.key, context: { required: needed } });
      throw forbidden();
    }
    const body = parse(RuleBody, req.body);
    const problem = validateRuleValue(spec, body.value);
    if (problem) throw new HttpError(400, 'validacao', 'Dados inválidos. Revise os campos indicados.', [{ path: 'value', message: problem }]);
    return db.transaction().execute(async (trx) => {
      await assertReference(trx, auth.institutionId, body.referenceId);
      const before = await trx.selectFrom('rule_parameter').selectAll().where('institution_id', '=', auth.institutionId).where('key', '=', spec.key).forUpdate().executeTakeFirst();
      if (before ? before.row_version !== body.rowVersion : body.rowVersion !== null) throw conflict();
      if (!before) {
        const created = await trx
          .insertInto('rule_parameter')
          .values({ institution_id: auth.institutionId, key: spec.key, value: JSON.stringify(body.value), reference_id: body.referenceId, approved_by: auth.userId, approved_by_name: auth.displayName, updated_at: new Date() })
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), { action: 'create', entity: 'rule_parameter', entityId: spec.key, before: null, after: created, context: { justification: body.justification } });
        return { ok: true, rowVersion: created.row_version };
      }
      const after = await trx
        .updateTable('rule_parameter')
        .set({ value: JSON.stringify(body.value), reference_id: body.referenceId, approved_by: auth.userId, approved_by_name: auth.displayName, updated_at: new Date(), row_version: before.row_version + 1 })
        .where('institution_id', '=', auth.institutionId)
        .where('key', '=', spec.key)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'update', entity: 'rule_parameter', entityId: spec.key, before, after, context: { justification: body.justification } });
      return { ok: true, rowVersion: after.row_version };
    });
  });

  /** Metadata the admin screens need (row versions are not part of the shared institution payload). */
  app.get('/config/versions', { preHandler: requirePermission(db, 'config:view') }, async (req) => {
    const auth = requireAuth(req);
    const [targets, rules, refs, policy] = await Promise.all([
      db.selectFrom('indicator_target').select(['indicator_id', 'row_version', 'approved_by_name', 'updated_at']).where('institution_id', '=', auth.institutionId).execute(),
      db.selectFrom('rule_parameter').select(['key', 'row_version', 'approved_by_name', 'updated_at']).where('institution_id', '=', auth.institutionId).execute(),
      db.selectFrom('clinical_reference').select(['id', 'code', 'row_version']).where('institution_id', '=', auth.institutionId).execute(),
      db.selectFrom('load_release_policy').select(['row_version', 'updated_at']).where('institution_id', '=', auth.institutionId).executeTakeFirst(),
    ]);
    return { targets, rules, references: refs, policy: policy ?? null };
  });

  /* ---------- References ---------- */
  app.post('/config/references', { preHandler: requirePermission(db, 'config:references:edit') }, async (req, reply) => {
    const auth = requireAuth(req);
    const b = parse(ReferenceCreate, req.body);
    const created = await db.transaction().execute(async (trx) => {
      const exists = await trx.selectFrom('clinical_reference').select('id').where('institution_id', '=', auth.institutionId).where('code', '=', b.code).executeTakeFirst();
      if (exists) throw new HttpError(409, 'duplicado', 'Já existe uma referência com este código.', [{ path: 'code', message: 'Código já utilizado.' }]);
      const row = await trx
        .insertInto('clinical_reference')
        .values({ institution_id: auth.institutionId, code: b.code, title: b.title, kind: b.kind, source: b.source, doc_version: b.version, updated_on: b.updatedAt, notes: b.notes, status: 'revisao_necessaria', validated_by: null, validated_by_name: null, validated_at: null, updated_at: new Date() })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'create', entity: 'clinical_reference', entityId: row.id, after: row, context: { justification: b.justification } });
      return row;
    });
    reply.code(201);
    return { id: created.id, rowVersion: created.row_version };
  });

  app.put<{ Params: { id: string } }>('/config/references/:id', { preHandler: requirePermission(db, 'config:references:edit') }, async (req) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(ReferenceUpdate, req.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('clinical_reference').selectAll().where('id', '=', id).where('institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst();
      if (!before) throw notFound('Referência');
      if (before.row_version !== b.rowVersion) throw conflict();
      // Any content change invalidates the previous validation.
      const after = await trx
        .updateTable('clinical_reference')
        .set({ title: b.title, kind: b.kind, source: b.source, doc_version: b.version, updated_on: b.updatedAt, notes: b.notes, status: 'revisao_necessaria', validated_by: null, validated_by_name: null, validated_at: null, updated_at: new Date(), row_version: before.row_version + 1 })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'update', entity: 'clinical_reference', entityId: id, before, after, context: { justification: b.justification } });
      return { ok: true, rowVersion: after.row_version };
    });
  });

  app.post<{ Params: { id: string } }>('/config/references/:id/validate', { preHandler: requirePermission(db, 'config:references:validate') }, async (req) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(ReferenceValidate, req.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('clinical_reference').selectAll().where('id', '=', id).where('institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst();
      if (!before) throw notFound('Referência');
      if (before.row_version !== b.rowVersion) throw conflict();
      const validated = b.status === 'vigente';
      const after = await trx
        .updateTable('clinical_reference')
        .set({ status: b.status, validated_by: validated ? auth.userId : null, validated_by_name: validated ? auth.displayName : null, validated_at: validated ? new Date() : null, updated_at: new Date(), row_version: before.row_version + 1 })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'validate', entity: 'clinical_reference', entityId: id, before, after, context: { justification: b.justification } });
      return { ok: true, rowVersion: after.row_version };
    });
  });

  /* ---------- CME load release policy ---------- */
  app.put('/config/load-release-policy', { preHandler: requirePermission(db, 'config:cme_policy:edit') }, async (req) => {
    const auth = requireAuth(req);
    const b = parse(PolicyBody, req.body);
    return db.transaction().execute(async (trx) => {
      await assertReference(trx, auth.institutionId, b.referenceId);
      const before = await trx.selectFrom('load_release_policy').selectAll().where('institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst();
      if (!before) throw notFound('Política');
      if (before.row_version !== b.rowVersion) throw conflict();
      const after = await trx
        .updateTable('load_release_policy')
        .set({ required_tests: [...new Set(b.requiredLoadTests)], require_daily_bowie_dick: b.requireDailyBowieDick, hold_implants_until_biological: b.holdImplantsUntilBiological, reference_id: b.referenceId, updated_at: new Date(), row_version: before.row_version + 1 })
        .where('institution_id', '=', auth.institutionId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'update', entity: 'load_release_policy', entityId: auth.institutionId, before, after, context: { justification: b.justification } });
      return { ok: true, rowVersion: after.row_version };
    });
  });
}
