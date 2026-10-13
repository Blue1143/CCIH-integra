import { randomBytes, randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import {
  SCANNABLE_STEPS, issueCode,
  type AssetDto, type CmeSectorDto, type FlowConfigDto, type Paged, type ProcessStep, type ProcessDetail, type ProcessSummaryDto, type ScanEventDto, type ScanResponse, type StationDto,
} from '@ccih/domain';
import type { DB } from '../db/types';
import type { Env } from '../env';
import { audit } from '../audit/audit';
import { actorOf, requireAuth, requirePermission, type AuthContext } from '../http/auth';
import { HttpError, conflict, forbidden, notFound, parse } from '../http/errors';
import { Instant, Justification, OptionalText, PageQuery, RowVersion, Text, Uuid, notFuture } from '../http/schemas';
import { sha256 } from '../security/crypto';
import { assertSector, escapeLike, institutionOrigin } from '../repositories/clinical';
import { loadFlowConfig, processSummaries, scanEventDtos, stationDtos } from '../repositories/cme-flow';
import { STATION_COOKIE, deviceOf, receiveLoose, scan } from '../services/scan';

const STEP = z.enum(SCANNABLE_STEPS as [string, ...string[]]);
const FlowBody = z.object({ storageRequired: z.boolean(), separationRequired: z.boolean(), rowVersion: z.number().int().min(0), justification: Justification }).strict();
const StationBody = z
  .object({
    sectorId: Uuid, name: Text(80), location: OptionalText(120), steps: z.array(STEP).min(1).max(11), inputMethods: z.array(z.enum(['leitor', 'camera', 'manual'])).min(1),
    symbologies: z.array(z.enum(['code128', 'code39'])).max(2), deviceLabel: OptionalText(80), responsibleUserId: Uuid.nullable(), requirePairing: z.boolean(),
    scanConfig: z.object({ maxKeyIntervalMs: z.number().int().min(5).max(200), minLength: z.number().int().min(3).max(60), terminator: z.enum(['enter', 'tab', 'nenhum']) }).strict(),
    enabled: z.boolean(), rowVersion: RowVersion.nullable(), justification: Justification,
  })
  .strict()
  .refine((b) => !b.inputMethods.some((m) => m !== 'manual') || b.symbologies.length > 0, { path: ['symbologies'], message: 'Escolha ao menos uma simbologia para leitor ou câmera.' });
const ScanBody = z
  .object({
    stationId: Uuid, code: z.string().max(200), inputMethod: z.enum(['leitor', 'camera', 'manual']), step: STEP, clientEventId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/).nullable(),
    deviceAt: Instant.nullable(), outcome: z.enum(['aprovado', 'relimpeza', 'descarte', 'retorno_estoque', 'reprocessar']).nullable(), destinationSectorId: Uuid.nullable(), originSectorId: Uuid.nullable(),
    loadId: Uuid.nullable(), packaging: z.enum(['papel_grau_cirurgico', 'sms', 'container_rigido', 'tecido_algodao', 'outro']).nullable(), justification: OptionalText(500), override: z.boolean(),
  })
  .strict()
  .refine((b) => !b.override || (b.justification ?? '').length >= 10, { path: ['justification'], message: 'Exceção exige justificativa (mínimo 10 caracteres).' });
const LooseBody = z.object({ stationId: Uuid, description: Text(200), setId: Uuid.nullable(), originSectorId: Uuid.nullable(), clientEventId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/).nullable() }).strict();
const AssetCreate = z.object({ setId: Uuid, count: z.number().int().min(1).max(50), tag: OptionalText(60), justification: Justification }).strict();
const AssetUpdate = z.object({ tag: OptionalText(60), status: z.enum(['ativo', 'manutencao', 'baixado']), statusReason: OptionalText(300), rowVersion: RowVersion, justification: Justification }).strict()
  .refine((b) => b.status === 'ativo' || !!b.statusReason, { path: ['statusReason'], message: 'Informe o motivo.' });
const ProcessQuery = z.object({ situacao: z.enum(['abertos', 'encerrados', 'todos']).default('abertos'), etapa: STEP.optional(), aguardando: STEP.optional(), q: z.string().trim().max(60).optional(), ...PageQuery }).strict();

const scopeOf = (auth: AuthContext) => (auth.scope ? (auth.scope.length ? auth.scope : ['00000000-0000-0000-0000-000000000000']) : null);

export async function cmeFlowRoutes(app: FastifyInstance, { db, env }: { db: Kysely<DB>; env: Env }) {
  const view = { preHandler: requirePermission(db, 'cme:view') };
  const stations = { preHandler: requirePermission(db, 'cme:stations:configure') };
  const configure = { preHandler: requirePermission(db, 'cme:configure') };
  const scanner = { preHandler: requirePermission(db, 'cme:scan') };

  /* ---------- Sectors (names only) ---------- */

  // The CME distributes to and receives from the whole hospital, so its users see every sector's
  // name even when their clinical scope is the CME alone. No patient data travels with it.
  app.get('/cme/sectors', view, async (req): Promise<{ sectors: CmeSectorDto[] }> => {
    const rows = await db.selectFrom('sector').select(['id', 'code', 'name', 'kind', 'active']).where('institution_id', '=', requireAuth(req).institutionId).orderBy('name').execute();
    return { sectors: rows.map((s) => ({ id: s.id, code: s.code, name: s.name, kind: s.kind, active: s.active })) };
  });

  /* ---------- Flow settings ---------- */

  app.get('/cme/flow-config', view, async (req): Promise<FlowConfigDto> => loadFlowConfig(db, requireAuth(req).institutionId));

  app.put('/cme/flow-config', stations, async (req) => {
    const auth = requireAuth(req);
    const b = parse(FlowBody, req.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('cme_flow_config').selectAll().where('institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst();
      if ((before?.row_version ?? 0) !== b.rowVersion) throw conflict();
      const values = { storage_required: b.storageRequired, separation_required: b.separationRequired, updated_at: new Date() };
      const after = before
        ? await trx.updateTable('cme_flow_config').set({ ...values, row_version: before.row_version + 1 }).where('institution_id', '=', auth.institutionId).returningAll().executeTakeFirstOrThrow()
        : await trx.insertInto('cme_flow_config').values({ institution_id: auth.institutionId, ...values }).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: before ? 'update' : 'create', entity: 'cme_flow_config', entityId: auth.institutionId, before: before ?? null, after, context: { justification: b.justification } });
      return { ok: true, rowVersion: after.row_version };
    });
  });

  /* ---------- Reading stations ---------- */

  app.get('/cme/stations', view, async (req): Promise<{ stations: StationDto[] }> => {
    const auth = requireAuth(req);
    return { stations: await stationDtos(db, auth.institutionId, scopeOf(auth)) };
  });

  /** Station this browser is paired with (the cookie is HttpOnly: the page cannot read it). */
  app.get('/cme/stations/this', view, async (req): Promise<{ station: StationDto | null; deviceId: string | null }> => {
    const auth = requireAuth(req);
    const device = await deviceOf(db, req.cookies[STATION_COOKIE]);
    if (!device) return { station: null, deviceId: null };
    const [station] = await stationDtos(db, auth.institutionId, scopeOf(auth), [device.station_id]);
    return { station: station ?? null, deviceId: station ? device.id : null };
  });

  const saveStation = async (auth: AuthContext, actor: ReturnType<typeof actorOf>, id: string | null, b: z.infer<typeof StationBody>) => {
    await assertSector(db, auth, b.sectorId);
    if (b.responsibleUserId && !(await db.selectFrom('app_user').select('id').where('id', '=', b.responsibleUserId).where('institution_id', '=', auth.institutionId).executeTakeFirst())) {
      throw new HttpError(400, 'validacao', 'Usuário inexistente.', [{ path: 'responsibleUserId', message: 'Usuário inexistente.' }]);
    }
    const values = {
      sector_id: b.sectorId, name: b.name, location: b.location, steps: b.steps as StationDto['steps'], input_methods: b.inputMethods, symbologies: b.symbologies, device_label: b.deviceLabel,
      responsible_user_id: b.responsibleUserId, require_pairing: b.requirePairing, scan_config: JSON.stringify(b.scanConfig), enabled: b.enabled, updated_at: new Date(),
    };
    return db.transaction().execute(async (trx) => {
      const dup = await trx.selectFrom('scan_station').select('id').where('institution_id', '=', auth.institutionId).where('name', '=', b.name).executeTakeFirst();
      if (dup && dup.id !== id) throw new HttpError(400, 'validacao', 'Já existe uma estação com este nome.', [{ path: 'name', message: 'Já existe uma estação com este nome.' }]);
      if (!id) {
        const created = await trx.insertInto('scan_station').values({ institution_id: auth.institutionId, ...values }).returningAll().executeTakeFirstOrThrow();
        await audit(trx, actor, { action: 'create', entity: 'scan_station', entityId: created.id, after: created, context: { justification: b.justification } });
        return { id: created.id, rowVersion: created.row_version };
      }
      const before = await trx.selectFrom('scan_station').selectAll().where('id', '=', id).where('institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst();
      if (!before || (auth.scope && !auth.scope.includes(before.sector_id))) throw notFound('Estação');
      if (before.row_version !== b.rowVersion) throw conflict();
      const after = await trx.updateTable('scan_station').set({ ...values, row_version: before.row_version + 1 }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actor, { action: 'update', entity: 'scan_station', entityId: id, before, after, context: { justification: b.justification } });
      return { id, rowVersion: after.row_version };
    });
  };

  app.post('/cme/stations', stations, async (req, reply) => {
    const b = parse(StationBody, req.body);
    reply.code(201);
    return saveStation(requireAuth(req), actorOf(req), null, b);
  });

  app.put<{ Params: { id: string } }>('/cme/stations/:id', stations, async (req) => {
    const b = parse(StationBody, req.body);
    if (b.rowVersion == null) throw new HttpError(400, 'validacao', 'Versão do registro obrigatória.', [{ path: 'rowVersion', message: 'Versão do registro obrigatória.' }]);
    return saveStation(requireAuth(req), actorOf(req), parse(Uuid, req.params.id), b);
  });

  /** Pairs this browser with the station: a random token in an HttpOnly cookie; only its hash is kept. */
  app.post<{ Params: { id: string } }>('/cme/stations/:id/pair', stations, async (req, reply) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const { label } = parse(z.object({ label: Text(80) }).strict(), req.body);
    const station = await db.selectFrom('scan_station').select(['id', 'sector_id']).where('id', '=', id).where('institution_id', '=', auth.institutionId).executeTakeFirst();
    if (!station || (auth.scope && !auth.scope.includes(station.sector_id))) throw notFound('Estação');
    const token = randomBytes(32).toString('base64url');
    const device = await db.transaction().execute(async (trx) => {
      // A browser belongs to one station: pairing again revokes the previous pairing of this browser.
      const previous = await deviceOf(trx, req.cookies[STATION_COOKIE]);
      if (previous) await trx.updateTable('station_device').set({ revoked_at: new Date(), revoked_by_name: auth.displayName }).where('id', '=', previous.id).execute();
      const created = await trx.insertInto('station_device').values({ station_id: id, token_hash: sha256(token), label, paired_by: auth.userId, paired_by_name: auth.displayName }).returning(['id', 'label']).executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: 'create', entity: 'station_device', entityId: created.id, after: { stationId: id, label }, context: { replaced: previous?.id ?? null } });
      return created;
    });
    reply.setCookie(STATION_COOKIE, token, { path: '/api', httpOnly: true, sameSite: 'strict', secure: env.COOKIE_SECURE, maxAge: 400 * 86_400 });
    reply.code(201);
    return { deviceId: device.id };
  });

  app.post<{ Params: { id: string } }>('/cme/stations/devices/:id/revoke', stations, async (req) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    return db.transaction().execute(async (trx) => {
      const device = await trx.selectFrom('station_device as d').innerJoin('scan_station as s', 's.id', 'd.station_id').select(['d.id', 'd.revoked_at', 's.sector_id', 's.institution_id']).where('d.id', '=', id).executeTakeFirst();
      if (!device || device.institution_id !== auth.institutionId || (auth.scope && !auth.scope.includes(device.sector_id))) throw notFound('Pareamento');
      if (device.revoked_at) return { ok: true };
      await trx.updateTable('station_device').set({ revoked_at: new Date(), revoked_by_name: auth.displayName }).where('id', '=', id).execute();
      await audit(trx, actorOf(req), { action: 'update', entity: 'station_device', entityId: id, context: { step: 'revogacao' } });
      return { ok: true };
    });
  });

  /* ---------- Physical assets ---------- */

  const assetDtos = async (auth: AuthContext, filter: { ids?: string[]; q?: string; setId?: string }): Promise<AssetDto[]> => {
    let q = db.selectFrom('instrument_asset as a').innerJoin('instrument_set as k', 'k.id', 'a.set_id')
      .leftJoin('cme_process as p', (j) => j.onRef('p.asset_id', '=', 'a.id').on('p.closed_at', 'is', null))
      .select(['a.id', 'a.code', 'a.set_id', 'k.name as set_name', 'a.tag', 'a.status', 'a.status_reason', 'a.row_version', 'p.id as process_id', 'p.current_step', 'p.state'])
      .where('a.institution_id', '=', auth.institutionId);
    if (filter.ids) q = q.where('a.id', 'in', filter.ids.length ? filter.ids : ['00000000-0000-0000-0000-000000000000']);
    if (filter.setId) q = q.where('a.set_id', '=', filter.setId);
    if (filter.q) q = q.where((eb) => eb.or([eb('a.code', 'like', `${escapeLike(filter.q!.toUpperCase())}%`), eb('k.name', 'ilike', `%${escapeLike(filter.q!)}%`), eb('a.tag', 'ilike', `%${escapeLike(filter.q!)}%`)]));
    const rows = await q.orderBy('k.name').orderBy('a.code').limit(500).execute();
    return rows.map((r) => ({
      id: r.id, code: r.code, setId: r.set_id, setName: r.set_name, tag: r.tag, status: r.status, statusReason: r.status_reason, rowVersion: r.row_version,
      openProcess: r.process_id ? { id: r.process_id, step: r.current_step!, state: r.state! } : null,
    }));
  };

  app.get('/cme/assets', view, async (req) => {
    const auth = requireAuth(req);
    const q = parse(z.object({ q: z.string().trim().max(60).optional(), setId: Uuid.optional() }).strict(), req.query);
    return { assets: await assetDtos(auth, { ...(q.q ? { q: q.q } : {}), ...(q.setId ? { setId: q.setId } : {}) }) };
  });

  app.post('/cme/assets', configure, async (req, reply) => {
    const auth = requireAuth(req);
    const b = parse(AssetCreate, req.body);
    const set = await db.selectFrom('instrument_set').select(['id', 'active']).where('id', '=', b.setId).where('institution_id', '=', auth.institutionId).executeTakeFirst();
    if (!set || !set.active) throw new HttpError(400, 'validacao', 'Caixa inexistente ou inativa.', [{ path: 'setId', message: 'Caixa inexistente ou inativa.' }]);
    const origin = await institutionOrigin(db, auth.institutionId);
    const ids = await db.transaction().execute(async (trx) => {
      const out: string[] = [];
      for (let i = 0; i < b.count; i++) {
        let code = '';
        for (let t = 0; t < 5; t++) {
          code = issueCode('ativo', () => randomInt(0, 1_000_000) / 1_000_000);
          if (!(await trx.selectFrom('instrument_asset').select('id').where('institution_id', '=', auth.institutionId).where('code', '=', code).executeTakeFirst())) break;
        }
        const row = await trx.insertInto('instrument_asset').values({ institution_id: auth.institutionId, set_id: b.setId, code, tag: b.tag, data_origin: origin }).returning('id').executeTakeFirstOrThrow();
        out.push(row.id);
      }
      await audit(trx, actorOf(req), { action: 'create', entity: 'instrument_asset', entityId: null, after: { setId: b.setId, count: b.count, ids: out }, context: { justification: b.justification } });
      return out;
    });
    reply.code(201);
    return { assets: await assetDtos(auth, { ids }) };
  });

  app.put<{ Params: { id: string } }>('/cme/assets/:id', configure, async (req) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(AssetUpdate, req.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('instrument_asset').selectAll().where('id', '=', id).where('institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst();
      if (!before) throw notFound('Material');
      if (before.row_version !== b.rowVersion) throw conflict();
      const after = await trx.updateTable('instrument_asset').set({ tag: b.tag, status: b.status, status_reason: b.status === 'ativo' ? null : b.statusReason, updated_at: new Date(), row_version: before.row_version + 1 }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), { action: before.status !== after.status ? 'status_change' : 'update', entity: 'instrument_asset', entityId: id, before, after, context: { justification: b.justification } });
      return { ok: true, rowVersion: after.row_version };
    });
  });

  /* ---------- Readings ---------- */

  /** Sectors and load sent with a reading are recorded with it: they must belong to the user's institution. */
  const assertOwnRefs = async (auth: AuthContext, b: { originSectorId: string | null; destinationSectorId?: string | null; loadId?: string | null }) => {
    const problems: Array<{ path: string; message: string }> = [];
    for (const path of ['originSectorId', 'destinationSectorId'] as const) {
      const id = b[path];
      if (id && !(await db.selectFrom('sector').select('id').where('id', '=', id).where('institution_id', '=', auth.institutionId).executeTakeFirst())) problems.push({ path, message: 'Setor inexistente.' });
    }
    if (b.loadId && !(await db.selectFrom('sterilization_load').select('id').where('id', '=', b.loadId).where('institution_id', '=', auth.institutionId).executeTakeFirst())) problems.push({ path: 'loadId', message: 'Carga inexistente.' });
    if (problems.length) throw new HttpError(400, 'validacao', problems[0]!.message, problems);
  };

  app.post('/cme/scan', scanner, async (req): Promise<ScanResponse> => {
    const auth = requireAuth(req);
    const b = parse(ScanBody, req.body);
    await assertOwnRefs(auth, b);
    if (b.deviceAt && !notFuture(b.deviceAt)) throw new HttpError(400, 'validacao', 'Data do dispositivo no futuro.', [{ path: 'deviceAt', message: 'Data do dispositivo no futuro.' }]);
    if (b.override && !auth.permissions.includes('cme:override')) {
      await audit(db, actorOf(req), { action: 'access_denied', entity: 'route', entityId: 'POST /cme/scan (exceção)', context: { required: ['cme:override'] } });
      throw forbidden();
    }
    return scan(db, auth, actorOf(req), { ...b, step: b.step as ProcessStep, justification: b.justification ?? null }, req.cookies[STATION_COOKIE]);
  });

  app.post('/cme/processes/loose', scanner, async (req, reply): Promise<ScanResponse> => {
    const auth = requireAuth(req);
    const b = parse(LooseBody, req.body);
    await assertOwnRefs(auth, b);
    reply.code(201);
    return receiveLoose(db, auth, b, req.cookies[STATION_COOKIE]);
  });

  app.get('/cme/processes', view, async (req): Promise<Paged<ProcessSummaryDto>> => {
    const auth = requireAuth(req);
    const q = parse(ProcessQuery, req.query);
    let list = db.selectFrom('cme_process as p').leftJoin('instrument_asset as a', 'a.id', 'p.asset_id').leftJoin('load_item as i', 'i.id', 'p.load_item_id').where('p.institution_id', '=', auth.institutionId);
    if (q.situacao === 'abertos') list = list.where('p.closed_at', 'is', null);
    if (q.situacao === 'encerrados') list = list.where('p.closed_at', 'is not', null);
    if (q.etapa) list = list.where('p.current_step', '=', q.etapa as never);
    // Materials that can be confirmed at a step (manual conference list). The server re-validates each one.
    if (q.aguardando) {
      const step = q.aguardando as ProcessStep;
      if (step === 'devolucao') list = list.where('p.state', '=', 'distribuido');
      else if (step === 'armazenamento' || step === 'separacao' || step === 'distribuicao') {
        list = list.where('p.closed_at', 'is', null).where('p.state', 'in', ['em_processo', 'liberado']).where('p.current_step', 'in', ['esterilizacao', 'armazenamento', 'separacao', 'devolucao'])
          .where('i.load_id', 'in', db.selectFrom('sterilization_load').select('id').where('status', '=', 'liberada'));
      } else list = list.where('p.closed_at', 'is', null).where(sql<boolean>`p.next_steps @> ARRAY[${step}]::text[]`);
    }
    if (q.q) {
      const t = escapeLike(q.q.toUpperCase());
      list = list.where((eb) => eb.or([eb('a.code', 'like', `${t}%`), eb('p.code', 'like', `${t}%`), eb('i.label_code', 'like', `${t}%`), eb('p.description', 'ilike', `%${escapeLike(q.q!)}%`)]));
    }
    const [ids, total] = await Promise.all([
      list.select('p.id').orderBy('p.updated_at', 'desc').limit(q.pageSize).offset((q.page - 1) * q.pageSize).execute(),
      list.select((e) => e.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { rows: await processSummaries(db, ids.map((r) => r.id)), total: Number(total.n), page: q.page, pageSize: q.pageSize };
  });

  app.get<{ Params: { id: string } }>('/cme/processes/:id', view, async (req): Promise<ProcessDetail> => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const row = await db.selectFrom('cme_process').select(['id', 'previous_process_id']).where('id', '=', id).where('institution_id', '=', auth.institutionId).executeTakeFirst();
    if (!row) throw notFound('Processo');
    const [summary] = await processSummaries(db, [id]);
    const next = await db.selectFrom('cme_process').select('id').where('previous_process_id', '=', id).executeTakeFirst();
    const events: ScanEventDto[] = await scanEventDtos(db, { processId: id, institutionId: auth.institutionId, limit: 500, scope: null });
    return { ...summary!, events: events.reverse(), previousProcessId: row.previous_process_id, nextProcessId: next?.id ?? null };
  });

  app.get('/cme/scan-events', view, async (req): Promise<{ events: ScanEventDto[] }> => {
    const auth = requireAuth(req);
    const q = parse(z.object({ stationId: Uuid.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).strict(), req.query);
    return { events: await scanEventDtos(db, { ...(q.stationId ? { stationId: q.stationId } : {}), institutionId: auth.institutionId, limit: q.limit, scope: scopeOf(auth) }) };
  });
}
