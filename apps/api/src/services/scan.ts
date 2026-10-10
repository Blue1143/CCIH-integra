import { randomInt } from 'node:crypto';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import {
  PROCESS_STEP_LABEL, checkAssembly, decideOverride, decideScan, issueCode, itemLabel, parseCode, rulesFromParameters, sterileUntil, todayIn,
  type InputMethod, type PackagingType, type ProcessSnapshot, type ProcessStep, type ScanDecision, type ScanResponse, type ScanResult,
} from '@ccih/domain';
import type { CmeProcessTable, DB } from '../db/types';
import { audit, type AuditActor } from '../audit/audit';
import { publish } from '../realtime/outbox';
import type { AuthContext } from '../http/auth';
import { HttpError, notFound } from '../http/errors';
import { sha256 } from '../security/crypto';
import { institutionOrigin } from '../repositories/clinical';
import { flowOf, loadFlowConfig, processSummaries, snapshotOf } from '../repositories/cme-flow';

/**
 * Server-side reading service: every reading is identified, validated against the station, the
 * process state and the safety blocks, and recorded — refused or not. Only an accepted decision
 * moves the process. The same reading sent twice (same station and client id) is applied once.
 */
export interface ScanInput {
  stationId: string;
  code: string;
  inputMethod: InputMethod;
  step: ProcessStep;
  clientEventId: string | null;
  deviceAt: Date | null;
  outcome: string | null;
  destinationSectorId: string | null;
  originSectorId: string | null;
  loadId: string | null;
  packaging: PackagingType | null;
  justification: string | null;
  override: boolean;
}

type Trx = Transaction<DB>;
type ProcessRow = Selectable<CmeProcessTable>;
const ACCEPTED: ScanResult[] = ['aceita', 'excecao_autorizada'];
export const STATION_COOKIE = 'ccih_station';

/** The station a paired browser belongs to (token in an HttpOnly cookie; only its hash is stored). */
export async function deviceOf(db: Kysely<DB> | Trx, token: string | undefined) {
  if (!token || token.length < 20) return null;
  return (await db.selectFrom('station_device').selectAll().where('token_hash', '=', sha256(token)).where('revoked_at', 'is', null).executeTakeFirst()) ?? null;
}

async function issueUnique(trx: Trx, institutionId: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = issueCode('processo', () => randomInt(0, 1_000_000) / 1_000_000);
    if (!(await trx.selectFrom('cme_process').select('id').where('institution_id', '=', institutionId).where('code', '=', code).executeTakeFirst())) return code;
  }
  throw new Error('Não foi possível emitir um código único');
}

export async function scan(db: Kysely<DB>, auth: AuthContext, actor: AuditActor, input: ScanInput, deviceToken: string | undefined): Promise<ScanResponse> {
  const station = await db.selectFrom('scan_station').selectAll().where('id', '=', input.stationId).where('institution_id', '=', auth.institutionId).executeTakeFirst();
  if (!station || (auth.scope && !auth.scope.includes(station.sector_id))) throw notFound('Estação');
  const device = await deviceOf(db, deviceToken);
  const deviceId = device && device.station_id === station.id ? device.id : null;

  if (input.clientEventId) {
    const replay = await replayOf(db, station.id, input.clientEventId);
    if (replay) return replay;
  }

  const [config, inst, params, origin] = await Promise.all([
    loadFlowConfig(db, auth.institutionId),
    db.selectFrom('institution').select('timezone').where('id', '=', auth.institutionId).executeTakeFirstOrThrow(),
    db.selectFrom('rule_parameter').select(['key', 'value', 'reference_id']).where('institution_id', '=', auth.institutionId).execute(),
    institutionOrigin(db, auth.institutionId),
  ]);
  const today = todayIn(inst.timezone);
  const shelfLife = rulesFromParameters(params.map((p) => ({ key: p.key, value: p.value, referenceId: p.reference_id }))).cme.shelfLifeDays?.value;
  const parsed = parseCode(input.code);

  try {
    return await db.transaction().execute(async (trx) => {
      const ev = {
        institution_id: auth.institutionId, station_id: station.id, device_id: deviceId, client_event_id: input.clientEventId, raw_code: parsed.code.slice(0, 200) || input.code.slice(0, 200),
        code_kind: parsed.kind, symbology: parsed.symbology, input_method: input.inputMethod, step: input.step, operation: input.step === 'esterilizacao' ? 'incluir_na_carga' : 'registrar_etapa',
        outcome: input.outcome, user_id: auth.userId, user_name: auth.displayName, device_at: input.deviceAt, origin_sector_id: input.originSectorId,
        destination_sector_id: input.destinationSectorId, justification: input.justification, data_origin: origin,
      };
      let processId: string | null = null;
      let assetId: string | null = null;
      let loadItemId: string | null = null;
      let loadId: string | null = input.loadId;
      let previousEventId: string | null = null;
      let details: Record<string, unknown> | null = null;
      let selectedLoad: ScanResponse['load'] = null;

      const record = async (result: ScanResult, message: string, operation = ev.operation) => {
        const row = await trx.insertInto('cme_scan_event').values({
          ...ev, operation, process_id: processId, asset_id: assetId, load_item_id: loadItemId, load_id: loadId, result, message, previous_event_id: previousEventId,
          details: details ? JSON.stringify(details) : null,
        }).returning('id').executeTakeFirstOrThrow();
        await trx.updateTable('scan_station').set({ last_seen_at: new Date() }).where('id', '=', station.id).execute();
        await publish(trx, { institutionId: auth.institutionId, topic: 'cme', permission: 'cme:view', sectorId: station.sector_id });
        if (deviceId) await trx.updateTable('station_device').set({ last_seen_at: new Date() }).where('id', '=', deviceId).execute();
        if (result === 'excecao_autorizada') await audit(trx, actor, { action: 'status_change', entity: 'cme_process', entityId: processId, context: { exception: true, step: input.step, justification: input.justification, eventId: row.id } });
        return { eventId: row.id, result, message, replay: false, process: processId ? (await processSummaries(trx, [processId]))[0] ?? null : null, load: selectedLoad };
      };
      const refuse = (result: ScanResult, message: string) => record(result, message);

      // 1. Station and input method.
      if (!station.enabled) return refuse('estacao_invalida', 'Estação desabilitada.');
      if (!station.steps.includes(input.step)) return refuse('estacao_invalida', `Esta estação não registra ${PROCESS_STEP_LABEL[input.step].toLowerCase()}.`);
      if (!station.input_methods.includes(input.inputMethod)) return refuse('estacao_invalida', 'Método de entrada não habilitado nesta estação.');
      if (station.require_pairing && !deviceId) return refuse('estacao_invalida', 'Este computador não está pareado com a estação.');

      // 2. Code: format, symbology, registered or issued by the system.
      if (parsed.problem) return refuse('codigo_desconhecido', parsed.problem);
      if (parsed.symbology && !station.symbologies.includes(parsed.symbology)) return refuse('codigo_desconhecido', 'Simbologia de código de barras não aceita nesta estação.');

      if (parsed.kind === 'carga') {
        const load = await trx.selectFrom('sterilization_load').select(['id', 'code']).where('institution_id', '=', auth.institutionId).where('code', '=', parsed.code).executeTakeFirst();
        if (!load) return refuse('codigo_desconhecido', 'Carga não encontrada.');
        loadId = load.id;
        if (input.step !== 'esterilizacao') return refuse('requer_conferencia', 'Código de carga: leia a etiqueta do pacote.');
        const packages = await trx.selectFrom('load_item').select((e) => e.fn.countAll<string>().as('n')).where('load_id', '=', load.id).executeTakeFirstOrThrow();
        selectedLoad = { id: load.id, code: load.code, packages: Number(packages.n) };
        return record('aceita', `Carga ${load.code} selecionada: leia os pacotes.`, 'selecionar_carga');
      }

      let process: ProcessRow | null = null;
      let asset: { id: string; status: string; status_reason: string | null; set_id: string } | null = null;
      let legacyItem: { id: string; description: string; set_id: string | null } | null = null;
      if (parsed.kind === 'ativo') {
        asset = (await trx.selectFrom('instrument_asset').select(['id', 'status', 'status_reason', 'set_id']).where('institution_id', '=', auth.institutionId).where('code', '=', parsed.code).forUpdate().executeTakeFirst()) ?? null;
        if (!asset) return refuse('codigo_desconhecido', 'Código de material não cadastrado.');
        assetId = asset.id;
        process = (await trx.selectFrom('cme_process').selectAll().where('asset_id', '=', asset.id).where('closed_at', 'is', null).forUpdate().executeTakeFirst()) ?? null;
      } else if (parsed.kind === 'processo') {
        process = (await trx.selectFrom('cme_process').selectAll().where('institution_id', '=', auth.institutionId).where('code', '=', parsed.code).forUpdate().executeTakeFirst()) ?? null;
        if (!process) return refuse('codigo_desconhecido', 'Código de processo não encontrado.');
      } else if (parsed.kind === 'pacote') {
        const item = await trx.selectFrom('load_item').select(['id', 'load_id', 'description', 'set_id', 'process_id']).where('institution_id', '=', auth.institutionId).where('label_code', '=', parsed.code).executeTakeFirst();
        if (!item) return refuse('codigo_desconhecido', 'Etiqueta de pacote não encontrada.');
        loadItemId = item.id;
        loadId = item.load_id;
        process = (await trx.selectFrom('cme_process').selectAll().where('load_item_id', '=', item.id).forUpdate().executeTakeFirst()) ?? null;
        if (!process) legacyItem = item;
      } else {
        return refuse('codigo_desconhecido', 'Código não reconhecido: não foi emitido pelo sistema nem está vinculado a um código do hospital.');
      }
      if (process) {
        processId = process.id;
        assetId ??= process.asset_id;
        loadItemId ??= process.load_item_id;
        if (process.asset_id && !asset) asset = (await trx.selectFrom('instrument_asset').select(['id', 'status', 'status_reason', 'set_id']).where('id', '=', process.asset_id).executeTakeFirst()) ?? null;
        previousEventId = (await trx.selectFrom('cme_scan_event').select('id').where('process_id', '=', process.id).orderBy('server_at', 'desc').limit(1).executeTakeFirst())?.id ?? null;
      }

      // 3. Current state. A package issued before the flow existed enters it right after sterilization.
      let snapshot: ProcessSnapshot = await snapshotOf(trx, process, asset ? { status: asset.status, reason: asset.status_reason } : null);
      if (legacyItem) {
        const pkg = await snapshotOf(trx, { load_item_id: legacyItem.id } as ProcessRow, null);
        snapshot = { ...snapshot, open: true, lastStep: 'esterilizacao', state: 'em_processo', nextSteps: [], package: pkg.package };
      }

      // 4. Assembly: the selected load must still be open for packages.
      let load: { id: string; code: string; started_at: Date | null; status: string; sterilizer_status: string } | null = null;
      if (input.step === 'esterilizacao') {
        if (!input.loadId) return refuse('requer_conferencia', 'Leia o código da carga antes dos pacotes.');
        load = (await trx.selectFrom('sterilization_load as l').innerJoin('sterilizer as s', 's.id', 'l.sterilizer_id').select(['l.id', 'l.code', 'l.started_at', 'l.status', 's.status as sterilizer_status'])
          .where('l.id', '=', input.loadId).where('l.institution_id', '=', auth.institutionId).forUpdate().executeTakeFirst()) ?? null;
        if (!load) return refuse('codigo_desconhecido', 'Carga não encontrada.');
        loadId = load.id;
        const problem = checkAssembly({ cycleStarted: !!load.started_at, status: load.status as never, sterilizerActive: load.sterilizer_status === 'ativo' });
        if (problem) return refuse(load.sterilizer_status === 'ativo' ? 'etapa_incorreta' : 'bloqueado', problem);
      }

      // 5. Destination of separation and exit.
      if (input.destinationSectorId && (input.step === 'separacao' || input.step === 'distribuicao')) {
        const dest = await trx.selectFrom('sector').select(['kind', 'active']).where('id', '=', input.destinationSectorId).where('institution_id', '=', auth.institutionId).executeTakeFirst();
        if (!dest || !dest.active || dest.kind === 'cme') return refuse('destino_incompativel', 'Setor de destino inválido.');
      }

      // 6. Flow rules (with authorized exception when requested).
      const req = { step: input.step, outcome: input.outcome, destinationId: input.destinationSectorId, today };
      const decision: ScanDecision = input.override ? decideOverride(snapshot, req, flowOf(config)) : decideScan(snapshot, req, flowOf(config));
      if (!ACCEPTED.includes(decision.result) || !decision.apply) return refuse(decision.result, decision.message);
      const a = decision.apply;

      // 7. Apply: open/close rounds, add packages to the load, move the process.
      if (legacyItem && !a.opens) {
        const created = await trx.insertInto('cme_process').values({
          institution_id: auth.institutionId, description: legacyItem.description, set_id: legacyItem.set_id, load_item_id: legacyItem.id, current_step: 'esterilizacao',
          state: 'em_processo', next_steps: [], legacy: true, data_origin: origin,
        }).returningAll().executeTakeFirstOrThrow();
        process = created;
        processId = created.id;
      }
      let message = decision.message;
      if (a.opens) {
        if (process && !process.closed_at) {
          await trx.updateTable('cme_process').set({ closed_at: new Date(), state: process.state === 'distribuido' ? 'encerrado' : 'devolvido', next_steps: [], updated_at: new Date(), row_version: process.row_version + 1 }).where('id', '=', process.id).execute();
        } else if (legacyItem) {
          // Close the implicit round of a pre-flow package before opening a new one.
          const closed = await trx.insertInto('cme_process').values({
            institution_id: auth.institutionId, description: legacyItem.description, set_id: legacyItem.set_id, load_item_id: legacyItem.id, current_step: 'esterilizacao',
            state: 'devolvido', next_steps: [], legacy: true, closed_at: new Date(), data_origin: origin,
          }).returning('id').executeTakeFirstOrThrow();
          process = { id: closed.id } as ProcessRow;
        }
        const code = asset ? null : await issueUnique(trx, auth.institutionId);
        const setId = asset?.set_id ?? process?.set_id ?? legacyItem?.set_id ?? null;
        const description = setId ? (await trx.selectFrom('instrument_set').select('name').where('id', '=', setId).executeTakeFirstOrThrow()).name : (process?.description ?? legacyItem?.description ?? 'Material avulso');
        const opened = await trx.insertInto('cme_process').values({
          institution_id: auth.institutionId, asset_id: asset?.id ?? null, code, set_id: setId, description, current_step: a.step, state: a.state, next_steps: a.nextSteps,
          previous_process_id: process?.id ?? null, data_origin: origin,
        }).returning('id').executeTakeFirstOrThrow();
        processId = opened.id;
        if (code) message = `${message} Novo código do material: ${code} (identifique o material).`;
      } else {
        const current = process!;
        let linkedItem = current.load_item_id;
        if (input.step === 'esterilizacao' && load) {
          const set = current.set_id ? await trx.selectFrom('instrument_set').select(['packaging', 'implant']).where('id', '=', current.set_id).executeTakeFirst() : null;
          const packed = await trx.selectFrom('cme_scan_event').select('details').where('process_id', '=', current.id).where('step', '=', 'embalagem').where('result', 'in', ACCEPTED).orderBy('server_at', 'desc').limit(1).executeTakeFirst();
          const packaging = input.packaging ?? ((packed?.details as { packaging?: PackagingType } | null)?.packaging) ?? set?.packaging ?? 'outro';
          const implant = set?.implant ?? false;
          const position = Number((await trx.selectFrom('load_item').select((e) => e.fn.max('position').as('p')).where('load_id', '=', load.id).executeTakeFirstOrThrow()).p ?? 0) + 1;
          const item = await trx.insertInto('load_item').values({
            institution_id: auth.institutionId, load_id: load.id, position, label_code: itemLabel(load.code, position), set_id: current.set_id, description: current.description,
            quantity: 1, packaging, implant, expires_on: sterileUntil(today, shelfLife), process_id: current.id,
          }).returning(['id', 'label_code']).executeTakeFirstOrThrow();
          if (implant) await trx.updateTable('sterilization_load').set({ has_implant: true, updated_at: new Date(), row_version: sql`row_version + 1` }).where('id', '=', load.id).execute();
          linkedItem = item.id;
          loadItemId = item.id;
          details = { labelCode: item.label_code, position, packaging };
          const packages = await trx.selectFrom('load_item').select((e) => e.fn.countAll<string>().as('n')).where('load_id', '=', load.id).executeTakeFirstOrThrow();
          selectedLoad = { id: load.id, code: load.code, packages: Number(packages.n) };
          message = `${message} Etiqueta ${item.label_code}.`;
        }
        if (input.step === 'embalagem' && input.packaging) details = { packaging: input.packaging };
        const destination = input.step === 'separacao' || input.step === 'distribuicao' ? input.destinationSectorId : input.step === 'devolucao' ? null : current.destination_sector_id;
        await trx.updateTable('cme_process').set({
          current_step: a.step, state: a.state, next_steps: a.nextSteps, load_item_id: linkedItem, destination_sector_id: destination,
          closed_at: a.closes ? new Date() : null, updated_at: new Date(), row_version: current.row_version + 1,
        }).where('id', '=', current.id).execute();
      }
      return record(decision.result, message);
    });
  } catch (e) {
    // Two identical readings at the same time: the unique index keeps one; answer with it.
    if ((e as { code?: string }).code === '23505' && input.clientEventId) {
      const replay = await replayOf(db, station.id, input.clientEventId);
      if (replay) return replay;
    }
    throw e;
  }
}

async function replayOf(db: Kysely<DB>, stationId: string, clientEventId: string): Promise<ScanResponse | null> {
  const e = await db.selectFrom('cme_scan_event').select(['id', 'result', 'message', 'process_id']).where('station_id', '=', stationId).where('client_event_id', '=', clientEventId).executeTakeFirst();
  if (!e) return null;
  return { eventId: e.id, result: e.result, message: e.message, replay: true, process: e.process_id ? (await processSummaries(db, [e.process_id]))[0] ?? null : null, load: null };
}

/** Loose material without an asset code: the reception issues a process code to label it. */
export async function receiveLoose(db: Kysely<DB>, auth: AuthContext, input: { stationId: string; description: string; setId: string | null; originSectorId: string | null; clientEventId: string | null }, deviceToken: string | undefined): Promise<ScanResponse> {
  const station = await db.selectFrom('scan_station').selectAll().where('id', '=', input.stationId).where('institution_id', '=', auth.institutionId).executeTakeFirst();
  if (!station || (auth.scope && !auth.scope.includes(station.sector_id))) throw notFound('Estação');
  if (!station.enabled || !station.steps.includes('recepcao') || !station.input_methods.includes('manual')) throw new HttpError(409, 'estacao_invalida', 'Esta estação não registra recepção de material avulso.');
  const device = await deviceOf(db, deviceToken);
  const deviceId = device && device.station_id === station.id ? device.id : null;
  if (station.require_pairing && !deviceId) throw new HttpError(409, 'estacao_invalida', 'Este computador não está pareado com a estação.');
  if (input.clientEventId) {
    const replay = await replayOf(db, station.id, input.clientEventId);
    if (replay) return replay;
  }
  const origin = await institutionOrigin(db, auth.institutionId);
  return db.transaction().execute(async (trx) => {
    let description = input.description;
    if (input.setId) {
      const set = await trx.selectFrom('instrument_set').select('name').where('id', '=', input.setId).where('institution_id', '=', auth.institutionId).executeTakeFirst();
      if (!set) throw new HttpError(400, 'validacao', 'Caixa inexistente.', [{ path: 'setId', message: 'Caixa inexistente.' }]);
      description = set.name;
    }
    const code = await issueUnique(trx, auth.institutionId);
    const process = await trx.insertInto('cme_process').values({
      institution_id: auth.institutionId, code, set_id: input.setId, description, current_step: 'recepcao', state: 'em_processo', next_steps: ['limpeza'], data_origin: origin,
    }).returning('id').executeTakeFirstOrThrow();
    const message = `Recepção registrada. Código emitido: ${code} (identifique o material).`;
    const ev = await trx.insertInto('cme_scan_event').values({
      institution_id: auth.institutionId, station_id: station.id, device_id: deviceId, client_event_id: input.clientEventId, raw_code: code, code_kind: 'processo', symbology: null,
      input_method: 'manual', process_id: process.id, asset_id: null, load_item_id: null, load_id: null, step: 'recepcao', operation: 'recepcao_avulso', outcome: null, details: null,
      result: 'aceita', message, user_id: auth.userId, user_name: auth.displayName, device_at: null, origin_sector_id: input.originSectorId, destination_sector_id: null,
      justification: null, previous_event_id: null, data_origin: origin,
    }).returning('id').executeTakeFirstOrThrow();
    await trx.updateTable('scan_station').set({ last_seen_at: new Date() }).where('id', '=', station.id).execute();
    await publish(trx, { institutionId: auth.institutionId, topic: 'cme', permission: 'cme:view', sectorId: station.sector_id });
    return { eventId: ev.id, result: 'aceita', message, replay: false, process: (await processSummaries(trx, [process.id]))[0] ?? null, load: null };
  });
}
