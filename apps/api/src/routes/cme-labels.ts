import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import {
  LABEL_FIELDS, LOAD_STATUS_LABEL, PACKAGING_LABEL, checkLabelLayout, dateInZone, labelContentProblems, labelPrintRefusal, labelPrintStatus, labelZpl,
  type LabelContent, type LabelEntity, type LabelField, type LabelLayoutDto, type LabelLayoutInput, type LabelPrintDto, type PrintedLabel,
} from '@ccih/domain';
import type { DB, LabelLayoutTable } from '../db/types';
import { audit } from '../audit/audit';
import { actorOf, requireAuth, requirePermission, type AuthContext } from '../http/auth';
import { HttpError, conflict, notFound, parse } from '../http/errors';
import { Justification, RowVersion, Text, Uuid } from '../http/schemas';
import { institutionOrigin } from '../repositories/clinical';

type Db = Kysely<DB> | Transaction<DB>;
const ENTITY = z.enum(['pacote', 'ativo', 'processo']);
const FIELD = z.enum(Object.keys(LABEL_FIELDS) as [LabelField, ...LabelField[]]);
const LayoutBody = z.object({
  name: Text(60), entity: ENTITY, widthMm: z.number(), heightMm: z.number(), marginMm: z.number(), dpi: z.number().int(), barHeightMm: z.number(),
  fields: z.array(FIELD).max(9), isDefault: z.boolean(), active: z.boolean(), rowVersion: RowVersion.nullable(), justification: Justification,
}).strict();
const PrintBody = z.object({
  entity: ENTITY, ids: z.array(Uuid).min(1).max(200), layoutId: Uuid, output: z.enum(['navegador', 'zpl']), mode: z.enum(['impressao', 'reimpressao']), reason: Justification.nullable(),
}).strict().refine((b) => b.mode === 'impressao' || b.reason, { path: ['reason'], message: 'A reimpressão exige o motivo.' });
const CancelBody = z.object({ reason: Justification }).strict();
const HistoryQuery = z.object({ entity: ENTITY.optional(), entityId: Uuid.optional(), situacao: z.enum(['ativas', 'todas']).default('todas'), q: z.string().trim().toUpperCase().max(60).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();

const NO_ID = '00000000-0000-0000-0000-000000000000';
const fieldError = (path: string, message: string) => new HttpError(400, 'validacao', message, [{ path, message }]);

function layoutDto(r: Selectable<LabelLayoutTable>): LabelLayoutDto {
  return {
    id: r.id, name: r.name, entity: r.entity, widthMm: Number(r.width_mm), heightMm: Number(r.height_mm), marginMm: Number(r.margin_mm), dpi: r.dpi,
    barHeightMm: Number(r.bar_height_mm), fields: r.fields as LabelField[], isDefault: r.is_default, active: r.active, dataOrigin: r.data_origin,
    rowVersion: r.row_version, updatedAt: r.updated_at.toISOString(),
  };
}
const layoutRows = (db: Db, institutionId: string) => db.selectFrom('label_layout').selectAll().where('institution_id', '=', institutionId).orderBy('entity').orderBy('name').execute();
const layoutInput = (l: LabelLayoutDto): LabelLayoutInput => ({ name: l.name, entity: l.entity, widthMm: l.widthMm, heightMm: l.heightMm, marginMm: l.marginMm, dpi: l.dpi, barHeightMm: l.barHeightMm, fields: l.fields });

async function printDtos(db: Db, institutionId: string, filter: { entity?: LabelEntity; entityId?: string; q?: string; ids?: string[]; activeOnly?: boolean; limit: number }): Promise<LabelPrintDto[]> {
  let q = db.selectFrom('label_print as p')
    .leftJoin('label_cancel as c', 'c.label_print_id', 'p.id')
    .leftJoin('label_print as r', 'r.replaces_id', 'p.id')
    .select(['p.id', 'p.entity', 'p.entity_id', 'p.code', 'p.kind', 'p.output', 'p.reason', 'p.layout', 'p.printed_at', 'p.printed_by_name', 'r.id as replaced_by_id', 'c.reason as cancel_reason', 'c.cancelled_at', 'c.cancelled_by_name'])
    .where('p.institution_id', '=', institutionId);
  if (filter.entity) q = q.where('p.entity', '=', filter.entity);
  if (filter.entityId) q = q.where('p.entity_id', '=', filter.entityId);
  if (filter.q) q = q.where('p.code', 'like', `${filter.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  if (filter.ids) q = q.where('p.id', 'in', filter.ids.length ? filter.ids : [NO_ID]);
  if (filter.activeOnly) q = q.where('c.id', 'is', null).where('r.id', 'is', null);
  const rows = await q.orderBy('p.printed_at', 'desc').orderBy('p.code').limit(filter.limit).execute();
  return rows.map((r) => {
    const base = { replacedById: r.replaced_by_id ?? null, cancelledAt: r.cancelled_at ? r.cancelled_at.toISOString() : null };
    return {
      id: r.id, entity: r.entity, entityId: r.entity_id, code: r.code, kind: r.kind, output: r.output, reason: r.reason, layoutName: (r.layout as LabelLayoutInput).name,
      printedAt: r.printed_at.toISOString(), printedBy: r.printed_by_name, status: labelPrintStatus(base), ...base, cancelReason: r.cancel_reason ?? null, cancelledBy: r.cancelled_by_name ?? null,
    };
  });
}

/** Content read from the records, with what decides whether a label may be printed. */
async function contents(db: Db, auth: AuthContext, entity: LabelEntity, ids: string[], tz: string): Promise<Array<{ id: string; content: LabelContent; refusal: string | null }>> {
  const scope = auth.scope ? (auth.scope.length ? auth.scope : [NO_ID]) : null;
  if (entity === 'pacote') {
    let q = db.selectFrom('load_item as i').innerJoin('sterilization_load as l', 'l.id', 'i.load_id').innerJoin('sterilizer as s', 's.id', 'l.sterilizer_id').leftJoin('instrument_set as k', 'k.id', 'i.set_id')
      .select(['i.id', 'i.label_code', 'i.description', 'i.expires_on', 'i.packaging', 'i.implant', 'l.code as load_code', 'l.status', 'l.started_at', 'l.created_at', 'l.program', 's.name as sterilizer', 'k.name as set_name'])
      .where('i.institution_id', '=', auth.institutionId).where('i.id', 'in', ids);
    if (scope) q = q.where('s.sector_id', 'in', scope);
    return (await q.execute()).map((r) => ({
      id: r.id,
      refusal: labelPrintRefusal({ entity, loadStatus: r.status }),
      content: {
        entity, code: r.label_code, material: r.description, processedOn: dateInZone(r.started_at ?? r.created_at, tz), expiresOn: r.expires_on ? String(r.expires_on).slice(0, 10) : null,
        lot: r.load_code, equipment: `${r.sterilizer} · ${r.program}`, release: LOAD_STATUS_LABEL[r.status], packaging: PACKAGING_LABEL[r.packaging], implant: r.implant, setName: r.set_name,
      },
    }));
  }
  if (entity === 'ativo') {
    const rows = await db.selectFrom('instrument_asset as a').innerJoin('instrument_set as k', 'k.id', 'a.set_id').select(['a.id', 'a.code', 'a.tag', 'a.status', 'k.name as set_name'])
      .where('a.institution_id', '=', auth.institutionId).where('a.id', 'in', ids).execute();
    return rows.map((r) => ({ id: r.id, refusal: labelPrintRefusal({ entity, assetStatus: r.status }), content: { entity, code: r.code, material: r.set_name, setName: r.set_name, tag: r.tag } }));
  }
  const rows = await db.selectFrom('cme_process as p').leftJoin('instrument_set as k', 'k.id', 'p.set_id').select(['p.id', 'p.code', 'p.description', 'p.opened_at', 'p.closed_at', 'k.name as set_name'])
    .where('p.institution_id', '=', auth.institutionId).where('p.id', 'in', ids).where('p.code', 'is not', null).execute();
  return rows.map((r) => ({
    id: r.id, refusal: labelPrintRefusal({ entity, processClosed: r.closed_at !== null }),
    content: { entity, code: r.code!, material: r.description, processedOn: dateInZone(r.opened_at, tz), setName: r.set_name },
  }));
}

export async function cmeLabelRoutes(app: FastifyInstance, { db }: { db: Kysely<DB> }) {
  const view = { preHandler: requirePermission(db, 'cme:view') };
  const configure = { preHandler: requirePermission(db, 'cme:stations:configure') };
  const printer = { preHandler: requirePermission(db, 'cme:scan', 'cme:cycle:record') };
  const canceller = { preHandler: requirePermission(db, 'cme:cycle:record') };

  /* ---------- Layouts ---------- */

  app.get('/cme/label-layouts', view, async (req): Promise<{ layouts: LabelLayoutDto[] }> => ({ layouts: (await layoutRows(db, requireAuth(req).institutionId)).map(layoutDto) }));

  const saveLayout = async (req: Parameters<typeof actorOf>[0], id: string | null) => {
    const auth = requireAuth(req);
    const b = parse(LayoutBody, req.body);
    const input: LabelLayoutInput = { name: b.name, entity: b.entity, widthMm: b.widthMm, heightMm: b.heightMm, marginMm: b.marginMm, dpi: b.dpi, barHeightMm: b.barHeightMm, fields: b.fields };
    const problems = checkLabelLayout(input);
    if (b.isDefault && !b.active) problems.push({ path: 'isDefault', message: 'Um layout inativo não pode ser o padrão.' });
    if (problems.length) throw new HttpError(400, 'validacao', problems[0]!.message, problems);
    const origin = await institutionOrigin(db, auth.institutionId);
    return db.transaction().execute(async (trx) => {
      const before = id ? await trx.selectFrom('label_layout').selectAll().where('id', '=', id).where('institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst() : undefined;
      if (id && !before) throw notFound('Layout');
      if (before && before.row_version !== b.rowVersion) throw conflict();
      if (before && before.entity !== b.entity) throw fieldError('entity', 'O tipo de etiqueta de um layout não muda: crie outro layout.');
      const dup = await trx.selectFrom('label_layout').select('id').where('institution_id', '=', auth.institutionId).where('name', '=', b.name).where('id', '!=', id ?? NO_ID).executeTakeFirst();
      if (dup) throw fieldError('name', 'Já existe um layout com este nome.');
      if (b.isDefault) await trx.updateTable('label_layout').set({ is_default: false }).where('institution_id', '=', auth.institutionId).where('entity', '=', b.entity).where('id', '!=', id ?? NO_ID).where('is_default', '=', true).execute();
      const values = {
        name: b.name, entity: b.entity, width_mm: b.widthMm, height_mm: b.heightMm, margin_mm: b.marginMm, dpi: b.dpi, bar_height_mm: b.barHeightMm, fields: b.fields,
        is_default: b.isDefault, active: b.active, updated_at: new Date(),
      };
      const after = before
        ? await trx.updateTable('label_layout').set({ ...values, row_version: before.row_version + 1 }).where('id', '=', before.id).returningAll().executeTakeFirstOrThrow()
        : await trx.insertInto('label_layout').values({ ...values, institution_id: auth.institutionId, data_origin: origin }).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: before ? 'update' : 'create', entity: 'label_layout', entityId: after.id, before: before ?? null, after, context: { justification: b.justification } });
      return layoutDto(after);
    });
  };
  app.post('/cme/label-layouts', configure, async (req) => saveLayout(req, null));
  app.put<{ Params: { id: string } }>('/cme/label-layouts/:id', configure, async (req) => saveLayout(req, parse(Uuid, req.params.id)));

  /* ---------- Prints ---------- */

  app.get('/cme/labels', view, async (req): Promise<{ prints: LabelPrintDto[] }> => {
    const q = parse(HistoryQuery, req.query);
    return { prints: await printDtos(db, requireAuth(req).institutionId, { ...(q.entity ? { entity: q.entity } : {}), ...(q.entityId ? { entityId: q.entityId } : {}), ...(q.q ? { q: q.q } : {}), activeOnly: q.situacao === 'ativas', limit: q.limit }) };
  });

  /**
   * Prints a batch. A first print needs no reason; a record that already has a label in use can only
   * be reprinted, with a reason, and the new label replaces the previous one. Content and layout are
   * read and kept at print time; the output (browser or ZPL) is generated from what was kept.
   */
  app.post('/cme/labels/print', printer, async (req): Promise<{ labels: PrintedLabel[]; zpl: string | null; prints: LabelPrintDto[] }> => {
    const auth = requireAuth(req);
    const b = parse(PrintBody, req.body);
    const ids = [...new Set(b.ids)];
    const [inst, origin] = await Promise.all([db.selectFrom('institution').select('timezone').where('id', '=', auth.institutionId).executeTakeFirstOrThrow(), institutionOrigin(db, auth.institutionId)]);
    return db.transaction().execute(async (trx) => {
      const layoutRow = await trx.selectFrom('label_layout').selectAll().where('id', '=', b.layoutId).where('institution_id', '=', auth.institutionId).executeTakeFirst();
      if (!layoutRow) throw notFound('Layout');
      const layout = layoutInput(layoutDto(layoutRow));
      if (!layoutRow.active) throw fieldError('layoutId', 'Layout inativo.');
      if (layout.entity !== b.entity) throw fieldError('layoutId', 'O layout escolhido é de outro tipo de etiqueta.');
      // Serializes prints of the same records (two stations printing the same package at once).
      for (const id of [...ids].sort()) await sql`SELECT pg_advisory_xact_lock(hashtext(${`label:${b.entity}:${id}`}))`.execute(trx);
      const found = await contents(trx, auth, b.entity, ids, inst.timezone);
      if (found.length !== ids.length) throw notFound(b.entity === 'pacote' ? 'Pacote' : b.entity === 'ativo' ? 'Ativo' : 'Processo com etiqueta de recepção');
      const problems = found.flatMap((f) => [f.refusal, ...labelContentProblems(layout, f.content)].filter((x): x is string => !!x).map((m) => `${f.content.code}: ${m}`));
      if (problems.length) throw new HttpError(422, 'etiqueta_recusada', problems[0]!, problems.map((message) => ({ path: 'ids', message })));
      const current = await printDtos(trx, auth.institutionId, { entity: b.entity, limit: 1000, ids: (await trx.selectFrom('label_print').select('id').where('institution_id', '=', auth.institutionId).where('entity', '=', b.entity).where('entity_id', 'in', ids).execute()).map((r) => r.id) });
      const active = new Map(current.filter((p) => p.status === 'ativa').map((p) => [p.entityId, p]));
      const order = new Map(ids.map((id, i) => [id, i]));
      found.sort((x, y) => order.get(x.id)! - order.get(y.id)!);
      if (b.mode === 'impressao') {
        const already = found.filter((f) => active.has(f.id)).map((f) => f.content.code);
        if (already.length) throw new HttpError(409, 'etiqueta_ja_impressa', `Já existe etiqueta em uso para ${already.join(', ')}. Use a reimpressão, com o motivo.`, already.map((c) => ({ path: 'ids', message: c })));
      } else {
        const missing = found.filter((f) => !active.has(f.id)).map((f) => f.content.code);
        if (missing.length) throw new HttpError(409, 'sem_etiqueta_ativa', `Não há etiqueta em uso para ${missing.join(', ')}: faça a impressão.`, missing.map((c) => ({ path: 'ids', message: c })));
      }
      const batchId = randomUUID();
      const labels: PrintedLabel[] = [];
      const printIds: string[] = [];
      for (const f of found) {
        const previous = active.get(f.id) ?? null;
        const row = await trx.insertInto('label_print').values({
          institution_id: auth.institutionId, batch_id: batchId, entity: b.entity, entity_id: f.id, code: f.content.code, kind: b.mode, output: b.output,
          reason: b.mode === 'reimpressao' ? b.reason : null, replaces_id: previous?.id ?? null, layout_id: layoutRow.id, layout: JSON.stringify(layout), content: JSON.stringify(f.content),
          printed_by: auth.userId, printed_by_name: auth.displayName, data_origin: origin,
        }).returning('id').executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: b.mode === 'reimpressao' ? 'reprint' : 'print', entity: 'label_print', entityId: row.id, before: previous ? { labelPrintId: previous.id, status: 'ativa' } : null,
          after: { entity: b.entity, entityId: f.id, code: f.content.code, layout: layout.name, output: b.output }, context: b.reason ? { justification: b.reason } : {},
        });
        labels.push({ printId: row.id, layout, content: f.content });
        printIds.push(row.id);
      }
      return {
        labels,
        zpl: b.output === 'zpl' ? labels.map((l) => labelZpl(l.layout, l.content)).join('\n') : null,
        prints: await printDtos(trx, auth.institutionId, { ids: printIds, limit: 200 }),
      };
    });
  });

  /** The label stops being valid (damaged, lost, wrong): the record has no label in use until printed again. */
  app.post<{ Params: { id: string } }>('/cme/labels/:id/cancel', canceller, async (req) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(CancelBody, req.body);
    return db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom('label_print').select(['id', 'entity', 'entity_id', 'code']).where('id', '=', id).where('institution_id', '=', auth.institutionId).executeTakeFirst();
      if (!row) throw notFound('Etiqueta');
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`label:${row.entity}:${row.entity_id}`}))`.execute(trx);
      const [dto] = await printDtos(trx, auth.institutionId, { ids: [id], limit: 1 });
      if (dto!.status !== 'ativa') throw new HttpError(409, 'etiqueta_nao_ativa', `A etiqueta já está ${dto!.status === 'cancelada' ? 'cancelada' : 'substituída'}.`);
      await trx.insertInto('label_cancel').values({ institution_id: auth.institutionId, label_print_id: id, reason: b.reason, cancelled_by: auth.userId, cancelled_by_name: auth.displayName }).execute();
      await audit(trx, actorOf(req), { action: 'cancel', entity: 'label_print', entityId: id, before: { status: 'ativa' }, after: { status: 'cancelada', code: row.code }, context: { justification: b.reason } });
      const [after] = await printDtos(trx, auth.institutionId, { ids: [id], limit: 1 });
      return after!;
    });
  });
}
