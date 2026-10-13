import {
  DEFAULT_SCAN_CONFIG,
  type FlowConfig, type FlowConfigDto, type ProcessSnapshot, type ProcessSummaryDto, type ScanConfig, type ScanEventDto, type StationDto,
} from '@ccih/domain';
import type { Selectable } from 'kysely';
import type { CmeProcessTable } from '../db/types';
import type { Db } from './clinical';

export async function loadFlowConfig(db: Db, institutionId: string): Promise<FlowConfigDto> {
  const row = await db.selectFrom('cme_flow_config').selectAll().where('institution_id', '=', institutionId).executeTakeFirst();
  // No row yet: the configurable steps (storage, separation) are optional.
  return row
    ? { storageRequired: row.storage_required, separationRequired: row.separation_required, rowVersion: row.row_version }
    : { storageRequired: false, separationRequired: false, rowVersion: 0 };
}

export const flowOf = (c: FlowConfigDto): FlowConfig => ({ storageRequired: c.storageRequired, separationRequired: c.separationRequired });

export function scanConfigOf(raw: unknown): ScanConfig {
  const r = (raw ?? {}) as Partial<ScanConfig>;
  return {
    maxKeyIntervalMs: Number.isInteger(r.maxKeyIntervalMs) ? r.maxKeyIntervalMs! : DEFAULT_SCAN_CONFIG.maxKeyIntervalMs,
    minLength: Number.isInteger(r.minLength) ? r.minLength! : DEFAULT_SCAN_CONFIG.minLength,
    terminator: r.terminator === 'tab' || r.terminator === 'nenhum' ? r.terminator : 'enter',
  };
}

export async function stationDtos(db: Db, institutionId: string, scope: string[] | null, ids?: string[]): Promise<StationDto[]> {
  let q = db.selectFrom('scan_station as s').leftJoin('app_user as u', 'u.id', 's.responsible_user_id').selectAll('s').select('u.display_name as responsible_name').where('s.institution_id', '=', institutionId);
  if (scope) q = q.where('s.sector_id', 'in', scope);
  if (ids) q = q.where('s.id', 'in', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
  const rows = await q.orderBy('s.name').execute();
  const devices = rows.length ? await db.selectFrom('station_device').selectAll().where('station_id', 'in', rows.map((r) => r.id)).orderBy('paired_at', 'desc').execute() : [];
  return rows.map((s) => ({
    id: s.id, sectorId: s.sector_id, name: s.name, location: s.location, steps: s.steps, inputMethods: s.input_methods, symbologies: s.symbologies as StationDto['symbologies'],
    deviceLabel: s.device_label, responsibleUserId: s.responsible_user_id, responsibleName: s.responsible_name, requirePairing: s.require_pairing, scanConfig: scanConfigOf(s.scan_config),
    enabled: s.enabled, lastSeenAt: s.last_seen_at?.toISOString() ?? null, rowVersion: s.row_version,
    devices: devices.filter((d) => d.station_id === s.id).map((d) => ({ id: d.id, label: d.label, pairedBy: d.paired_by_name, pairedAt: d.paired_at.toISOString(), lastSeenAt: d.last_seen_at?.toISOString() ?? null, revoked: !!d.revoked_at })),
  }));
}

type ProcessRow = Selectable<CmeProcessTable>;

/** What the flow rules need to know about a process (package, load decision, asset). */
export async function snapshotOf(db: Db, process: ProcessRow | null, assetStatus: { status: string; reason: string | null } | null): Promise<ProcessSnapshot> {
  const assetBlocked = assetStatus && assetStatus.status !== 'ativo' ? `Material ${assetStatus.status === 'manutencao' ? 'em manutenção' : 'baixado'}: ${assetStatus.reason ?? 'sem motivo registrado'}.` : null;
  if (!process) return { open: false, lastStep: null, state: null, nextSteps: [], package: null, plannedDestinationId: null, assetBlocked };
  let pkg: ProcessSnapshot['package'] = null;
  if (process.load_item_id) {
    const row = await db.selectFrom('load_item as i').innerJoin('sterilization_load as l', 'l.id', 'i.load_id')
      .select((eb) => ['i.expires_on', 'l.status', 'l.started_at',
        eb.exists(eb.selectFrom('load_release_decision as d').select('d.id').whereRef('d.load_id', '=', 'l.id').where('d.from_status', '=', 'liberada').where('d.to_status', '=', 'rejeitada')).as('recalled')])
      .where('i.id', '=', process.load_item_id).executeTakeFirstOrThrow();
    pkg = { loadStatus: row.status, cycleStarted: !!row.started_at, expiresOn: row.expires_on, recalled: !!row.recalled };
  }
  return {
    open: !process.closed_at, lastStep: process.current_step, state: process.state, nextSteps: process.next_steps, package: pkg,
    plannedDestinationId: process.destination_sector_id, assetBlocked,
  };
}

export async function processSummaries(db: Db, ids: string[]): Promise<ProcessSummaryDto[]> {
  if (!ids.length) return [];
  const rows = await db.selectFrom('cme_process as p')
    .leftJoin('instrument_asset as a', 'a.id', 'p.asset_id').leftJoin('instrument_set as k', 'k.id', 'p.set_id')
    .leftJoin('load_item as i', 'i.id', 'p.load_item_id').leftJoin('sterilization_load as l', 'l.id', 'i.load_id')
    .selectAll('p').select(['a.code as asset_code', 'k.name as set_name', 'i.label_code', 'l.id as load_id', 'l.code as load_code', 'l.status as load_status'])
    .where('p.id', 'in', ids).execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const p = byId.get(id);
    if (!p) return [];
    return [{
      id: p.id, code: p.asset_code ?? p.code ?? p.label_code ?? p.id, assetCode: p.asset_code, description: p.description, setName: p.set_name, currentStep: p.current_step, state: p.state,
      nextSteps: p.next_steps, packageLabel: p.label_code, loadId: p.load_id, loadCode: p.load_code, loadStatus: p.load_status, destinationSectorId: p.destination_sector_id,
      openedAt: p.opened_at.toISOString(), closedAt: p.closed_at?.toISOString() ?? null, legacy: p.legacy, origin: p.data_origin,
    }];
  });
}

export async function scanEventDtos(db: Db, where: { processId?: string; stationId?: string; institutionId: string; limit: number; scope: string[] | null }): Promise<ScanEventDto[]> {
  let q = db.selectFrom('cme_scan_event as e').leftJoin('scan_station as s', 's.id', 'e.station_id').leftJoin('station_device as d', 'd.id', 'e.device_id')
    // Same organization only, even if an old event points elsewhere.
    .leftJoin('sterilization_load as l', (j) => j.onRef('l.id', '=', 'e.load_id').onRef('l.institution_id', '=', 'e.institution_id'))
    .selectAll('e').select(['s.name as station_name', 's.sector_id as station_sector', 'd.label as device_label', 'l.code as load_code'])
    .where('e.institution_id', '=', where.institutionId);
  if (where.processId) q = q.where('e.process_id', '=', where.processId);
  if (where.stationId) q = q.where('e.station_id', '=', where.stationId);
  if (where.scope) q = q.where((eb) => eb.or([eb('s.sector_id', 'in', where.scope!), eb('e.station_id', 'is', null)]));
  const rows = await q.orderBy('e.server_at', 'desc').limit(where.limit).execute();
  return rows.map((e) => ({
    id: e.id, rawCode: e.raw_code, codeKind: e.code_kind, inputMethod: e.input_method, step: e.step, operation: e.operation, outcome: e.outcome, result: e.result, message: e.message,
    userName: e.user_name, stationId: e.station_id, stationName: e.station_name, device: e.device_label, serverAt: e.server_at.toISOString(), deviceAt: e.device_at?.toISOString() ?? null,
    originSectorId: e.origin_sector_id, destinationSectorId: e.destination_sector_id, justification: e.justification, processId: e.process_id, loadId: e.load_id, loadCode: e.load_code,
  }));
}
