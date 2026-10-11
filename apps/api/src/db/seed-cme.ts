import { randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import { addDays, dateInZone, evaluateLoadRelease, issueCode, itemLabel, loadCode, sterileUntil, todayIn, zonedInstant, type LoadStatus, type LoadTest, type ProcessStep } from '@ccih/domain';
import { DEMO_LOAD_POLICY, DEMO_SETS, DEMO_STERILIZERS, generateCme, hashSeed, rng } from '@ccih/demo-data';
import type { DB } from './types';

export interface CmeSeedContext {
  institutionId: string;
  sectorIds: Map<string, string>;
  from: string;
  now: Date;
  timezone: string;
  shelfLifeDays: number | undefined;
}

const OPERATOR = 'Técnico(a) de CME (demonstração)';
const RT = 'Responsável CME (demonstração)';

async function insertChunked<T extends keyof DB>(trx: Transaction<DB>, table: T, rows: Array<Record<string, unknown>>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic bulk insert over typed tables
  for (let i = 0; i < rows.length; i += 500) await trx.insertInto(table).values(rows.slice(i, i + 500) as any).execute();
}

/** Synthetic CME records (data_origin = demo). Runs after the clinical seed (uses its surgeries). */
export async function seedCme(trx: Transaction<DB>, ctx: CmeSeedContext) {
  const inst = ctx.institutionId;
  const tz = ctx.timezone;
  const origin = 'demo' as const;
  const cmeSector = ctx.sectorIds.get('cme')!;
  const today = todayIn(tz, ctx.now);

  const sterilizers = new Map<string, { id: string; code: string; type: string }>();
  for (const s of DEMO_STERILIZERS) {
    const row = await trx.insertInto('sterilizer').values({ institution_id: inst, sector_id: cmeSector, code: s.code, name: s.name, type: s.type, serial: s.serial, status: 'ativo', status_reason: null, qualification_due_on: addDays(today, s.qualificationInDays), updated_at: ctx.now }).returning('id').executeTakeFirstOrThrow();
    sterilizers.set(s.code, { id: row.id, code: s.code, type: s.type });
  }
  const sets = new Map<string, { id: string; name: string; packaging: string; implant: boolean }>();
  for (const s of DEMO_SETS) {
    const row = await trx.insertInto('instrument_set').values({ institution_id: inst, code: s.code, name: s.name, specialty: s.specialty, composition: null, item_count: s.itemCount, packaging: s.packaging, implant: s.implant, updated_at: ctx.now }).returning('id').executeTakeFirstOrThrow();
    sets.set(s.code, { id: row.id, name: s.name, packaging: s.packaging, implant: s.implant });
  }

  const surgeries = await trx.selectFrom('surgery').select(['id', 'started_at', 'implant', 'sector_id']).where('institution_id', '=', inst).where('started_at', '>=', zonedInstant(ctx.from, 0, tz)).execute();
  const data = generateCme({ from: ctx.from, now: ctx.now, timezone: tz, surgeries: surgeries.map((s) => ({ id: s.id, startedAt: s.started_at, implant: s.implant })) });

  const bdRows = data.bowieDick.map((b) => ({
    id: randomUUID(), institution_id: inst, sterilizer_id: sterilizers.get(b.sterilizerCode)!.id, load_id: null, type: 'BOWIE_DICK', result: b.result, performed_at: b.performedAt,
    performed_on: dateInZone(b.performedAt, tz), indicator_lot: `BD-${dateInZone(b.performedAt, tz).slice(0, 7).replace('-', '')}`, indicator_expiry: addDays(today, 365),
    incubation_start: null, read_at: null, control_result: null, notes: b.notes, recorded_by: null, recorded_by_name: OPERATOR, replaces_id: null, justification: null, data_origin: origin,
  }));
  await insertChunked(trx, 'sterilization_test', bdRows);

  // Codes follow the order of the cycles of each sterilizer on each day.
  const ordered = [...data.loads].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const seq = new Map<string, number>();
  const loadIds = new Map<string, string>();
  const itemIds = new Map<string, string>();
  const loads: Array<Record<string, unknown>> = [];
  const items: Array<Record<string, unknown>> = [];
  const tests: Array<Record<string, unknown>> = [];
  const decisions: Array<Record<string, unknown>> = [];
  const snapshot = JSON.stringify({ version: 1, ...DEMO_LOAD_POLICY, referenceId: null });
  for (const l of ordered) {
    const st = sterilizers.get(l.sterilizerCode)!;
    const day = dateInZone(l.startedAt, tz);
    const n = (seq.get(`${st.code}|${day}`) ?? 0) + 1;
    seq.set(`${st.code}|${day}`, n);
    const code = loadCode(st.code, day, n);
    const id = randomUUID();
    loadIds.set(l.key, id);
    const status: LoadStatus = l.decisions.at(-1)?.to ?? 'aguardando';
    const hasImplant = l.sets.some((c) => sets.get(c)!.implant);
    loads.push({
      id, institution_id: inst, sterilizer_id: st.id, code, program: l.program, started_at: l.startedAt, ended_at: l.endedAt, operator_id: null, operator_name: OPERATOR,
      temperature_c: l.temperatureC, pressure_kpa: l.pressureKpa, exposure_minutes: l.exposureMinutes, physical_result: l.physical, notes: null, status, has_implant: hasImplant,
      reprocessed_from_id: l.reprocessedFromKey ? loadIds.get(l.reprocessedFromKey)! : null, data_origin: origin, created_at: l.startedAt, updated_at: l.decisions.at(-1)?.at ?? l.startedAt,
      row_version: 1 + (l.endedAt ? 1 : 0) + l.decisions.length,
    });
    const expires = sterileUntil(day, ctx.shelfLifeDays);
    l.sets.forEach((setCode, i) => {
      const set = sets.get(setCode)!;
      const itemId = randomUUID();
      itemIds.set(`${l.key}#${i}`, itemId);
      items.push({ id: itemId, institution_id: inst, load_id: id, position: i + 1, label_code: itemLabel(code, i + 1), set_id: set.id, description: set.name, quantity: 1, packaging: set.packaging, implant: set.implant, expires_on: expires });
    });
    for (const t of l.tests) {
      const testId = randomUUID();
      const lot = t.type === 'IB' ? 'IB-DEMO-2611' : 'IQ5-DEMO-2611';
      tests.push({
        id: testId, institution_id: inst, sterilizer_id: st.id, load_id: id, type: t.type, result: t.result, performed_at: t.performedAt, performed_on: dateInZone(t.performedAt, tz),
        indicator_lot: lot, indicator_expiry: addDays(today, 300), incubation_start: t.incubationStart, read_at: null, control_result: null, notes: null, recorded_by: null,
        recorded_by_name: OPERATOR, replaces_id: null, justification: null, data_origin: origin,
      });
      if (t.reading) {
        tests.push({
          id: randomUUID(), institution_id: inst, sterilizer_id: st.id, load_id: id, type: t.type, result: t.reading.result, performed_at: t.performedAt, performed_on: dateInZone(t.performedAt, tz),
          indicator_lot: lot, indicator_expiry: addDays(today, 300), incubation_start: t.incubationStart, read_at: t.reading.readAt, control_result: 'positivo',
          notes: t.reading.result === 'reprovado' ? 'Viragem de cor do meio de cultura (crescimento).' : null, recorded_by: null, recorded_by_name: OPERATOR, replaces_id: testId,
          justification: 'Leitura do indicador biológico.', data_origin: origin,
        });
      }
    }
    decisions.push({ id: randomUUID(), load_id: id, from_status: null, to_status: 'aguardando', decided_at: l.startedAt, decided_by: null, decided_by_name: OPERATOR, justification: 'Carga registrada.', policy_snapshot: null, evaluation: JSON.stringify({ status: 'aguardando', reasons: [] }) });
    let from: LoadStatus = 'aguardando';
    for (const d of l.decisions) {
      // The evaluation recorded with each decision is the policy applied to what was known at that moment.
      const known: LoadTest[] = [];
      if (l.physical) known.push({ type: 'REGISTRO_FISICO', result: l.physical === 'conforme' ? 'aprovado' : 'reprovado' });
      for (const t of l.tests) known.push({ type: t.type, result: t.reading && t.reading.readAt <= d.at ? t.reading.result : t.result });
      const ev = evaluateLoadRelease({ tests: known, hasImplant, bowieDickApplies: st.type === 'vapor_prevacuo', equipmentBowieDick: 'aprovado' }, DEMO_LOAD_POLICY);
      decisions.push({ id: randomUUID(), load_id: id, from_status: from, to_status: d.to, decided_at: d.at, decided_by: null, decided_by_name: RT, justification: d.justification, policy_snapshot: snapshot, evaluation: JSON.stringify({ status: ev.status, reasons: ev.reasons }) });
      from = d.to;
    }
  }
  await insertChunked(trx, 'sterilization_load', loads);
  await insertChunked(trx, 'load_item', items);
  await insertChunked(trx, 'sterilization_test', tests);
  await insertChunked(trx, 'load_release_decision', decisions);

  const surgerySector = new Map(surgeries.map((s) => [s.id, s.sector_id]));
  await insertChunked(trx, 'material_use', data.uses.map((u) => ({
    institution_id: inst, item_id: itemIds.get(`${u.loadKey}#${u.itemIndex}`)!, surgery_id: u.surgeryId, sector_id: u.surgeryId ? surgerySector.get(u.surgeryId)! : ctx.sectorIds.get(u.sectorCode!)!,
    used_at: u.usedAt, recorded_by: null, recorded_by_name: u.surgeryId ? 'Centro cirúrgico (demonstração)' : 'Enfermagem (demonstração)', data_origin: origin,
  })));
  const flow = await seedFlow(trx, ctx, sets);
  return { cmeLoads: loads.length, cmeTests: tests.length + bdRows.length, cmeUses: data.uses.length, ...flow };
}

/** Demo stations (one per step group), physical assets with issued codes and a few materials in progress. */
export const DEMO_STATIONS: Array<{ name: string; location: string; steps: ProcessStep[] }> = [
  { name: 'Expurgo — recepção', location: 'Área suja', steps: ['recepcao'] },
  { name: 'Limpeza', location: 'Área suja', steps: ['limpeza'] },
  { name: 'Inspeção e preparo', location: 'Área limpa', steps: ['inspecao', 'preparo'] },
  { name: 'Embalagem', location: 'Área limpa', steps: ['embalagem'] },
  { name: 'Montagem de carga', location: 'Área de esterilização', steps: ['esterilizacao'] },
  { name: 'Arsenal', location: 'Área estéril', steps: ['armazenamento', 'separacao'] },
  { name: 'Expedição', location: 'Área estéril', steps: ['distribuicao'] },
  { name: 'Devoluções', location: 'Área suja', steps: ['devolucao'] },
];

async function seedFlow(trx: Transaction<DB>, ctx: CmeSeedContext, sets: Map<string, { id: string; name: string }>) {
  const inst = ctx.institutionId;
  const cmeSector = ctx.sectorIds.get('cme')!;
  const r = rng(hashSeed('cme-flow'));
  await trx.insertInto('cme_flow_config').values({ institution_id: inst, updated_at: ctx.now }).execute();
  const stationIds = new Map<string, string>();
  for (const st of DEMO_STATIONS) {
    // Demo stations do not require pairing so any browser can try them; a real installation pairs each workstation.
    const row = await trx.insertInto('scan_station').values({
      institution_id: inst, sector_id: cmeSector, name: st.name, location: st.location, steps: st.steps, input_methods: ['leitor', 'camera', 'manual'], symbologies: ['code128', 'code39'],
      device_label: null, responsible_user_id: null, require_pairing: false, scan_config: JSON.stringify({ maxKeyIntervalMs: 35, minLength: 6, terminator: 'enter' }), updated_at: ctx.now,
    }).returning('id').executeTakeFirstOrThrow();
    for (const step of st.steps) stationIds.set(step, row.id);
  }
  const assets: Array<{ id: string; code: string; setId: string; name: string }> = [];
  for (const s of DEMO_SETS) {
    const set = sets.get(s.code)!;
    for (let i = 0; i < 2; i++) {
      const code = issueCode('ativo', r);
      const row = await trx.insertInto('instrument_asset').values({ institution_id: inst, set_id: set.id, code, tag: `${s.code}-${i + 1}`, data_origin: 'demo' }).returning('id').executeTakeFirstOrThrow();
      assets.push({ id: row.id, code, setId: set.id, name: set.name });
    }
  }
  // Materials in progress: received three hours ago and moved step by step, every 20 minutes.
  const chains: ProcessStep[][] = [['recepcao'], ['recepcao', 'limpeza'], ['recepcao', 'limpeza', 'inspecao'], ['recepcao', 'limpeza', 'inspecao', 'preparo', 'embalagem'], ['recepcao', 'limpeza', 'inspecao', 'preparo', 'embalagem']];
  const next: Record<string, ProcessStep[]> = { recepcao: ['limpeza'], limpeza: ['inspecao'], inspecao: ['preparo'], preparo: ['embalagem'], embalagem: ['esterilizacao'] };
  const start = ctx.now.getTime() - 3 * 3_600_000;
  let events = 0;
  for (const [i, chain] of chains.entries()) {
    const asset = assets.filter((a) => !a.name.includes('Ótica'))[i * 3]!;
    const last = chain.at(-1)!;
    const process = await trx.insertInto('cme_process').values({
      institution_id: inst, asset_id: asset.id, set_id: asset.setId, description: asset.name, current_step: last, state: 'em_processo', next_steps: next[last]!,
      opened_at: new Date(start + i * 5 * 60_000), updated_at: new Date(start + (i * 5 + (chain.length - 1) * 20) * 60_000), data_origin: 'demo',
    }).returning('id').executeTakeFirstOrThrow();
    let previous: string | null = null;
    for (const [k, step] of chain.entries()) {
      const at = new Date(start + (i * 5 + k * 20) * 60_000);
      const ev = await trx.insertInto('cme_scan_event').values({
        institution_id: inst, station_id: stationIds.get(step)!, device_id: null, client_event_id: null, raw_code: asset.code, code_kind: 'ativo', symbology: 'code128', input_method: 'leitor',
        process_id: process.id, asset_id: asset.id, load_item_id: null, load_id: null, step, operation: 'registrar_etapa', outcome: step === 'inspecao' ? 'aprovado' : null, details: null,
        result: 'aceita', message: 'Etapa registrada.', user_id: null, user_name: OPERATOR, server_at: at, device_at: null, origin_sector_id: step === 'recepcao' ? ctx.sectorIds.get('centro-cirurgico')! : null,
        destination_sector_id: null, justification: null, previous_event_id: previous, data_origin: 'demo',
      }).returning('id').executeTakeFirstOrThrow();
      previous = ev.id;
      events++;
    }
  }
  // Demonstration layouts sized for a 203 dpi thermal printer; the real size depends on the printer the institution adopts.
  await trx.insertInto('label_layout').values([
    { institution_id: inst, name: 'Pacote estéril 70×40 mm (demonstração)', entity: 'pacote', width_mm: 70, height_mm: 40, margin_mm: 2, dpi: 203, bar_height_mm: 10, fields: ['processamento', 'validade', 'lote', 'equipamento', 'implante'], is_default: true, data_origin: 'demo', updated_at: ctx.now },
    { institution_id: inst, name: 'Ativo 50×25 mm (demonstração)', entity: 'ativo', width_mm: 50, height_mm: 25, margin_mm: 2, dpi: 203, bar_height_mm: 8, fields: ['identificacao'], is_default: true, data_origin: 'demo', updated_at: ctx.now },
    { institution_id: inst, name: 'Recepção avulsa 50×25 mm (demonstração)', entity: 'processo', width_mm: 50, height_mm: 25, margin_mm: 2, dpi: 203, bar_height_mm: 8, fields: ['processamento'], is_default: true, data_origin: 'demo', updated_at: ctx.now },
  ]).execute();
  return { cmeStations: DEMO_STATIONS.length, cmeAssets: assets.length, cmeFlowEvents: events, labelLayouts: 3 };
}
