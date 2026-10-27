import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type RawBuilder } from 'kysely';
import { seedDemo } from '../src/db/seed';
import { TEST_PASSWORD, accessBody, login, setupTestApp, teardown, type Session, type TestContext } from './helpers';

/**
 * Isolation between organizations for identifiers sent INSIDE request bodies (and the query string
 * of write routes). tenancy.test.ts sweeps every route with identifiers of organization B in the
 * path; its bodies are empty, so validation stops them before any lookup. Here each write route gets
 * a VALID body of organization A in which ONE identifier field is replaced by an identifier of B.
 *
 * For each case: the call with B's identifier must not be accepted, must not echo anything of B, and
 * must not write any row that references B. The same call with A's own identifier must be accepted
 * (positive control: the body is valid and the refusal is due to the foreign identifier alone).
 */
let ctx: TestContext;
let A: Session;
let instA: string;
let instB: string;
const uploads = mkdtempSync(join(tmpdir(), 'ccih-iso-bodies-'));
/** Every identifier created by organization B (its seed plus the records made through its own API). */
const allB = new Set<string>();
/** Codes that exist only in organization B (random codes; the seeded ones repeat across organizations). */
const bTokens: string[] = [];
let tables: string[];
let bRowsBefore: Map<string, Set<string>>;

const J = 'Teste de isolamento entre organizações';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** Identifiers of B in a text. */
const idsOfB = (text: string) => [...new Set(text.match(UUID) ?? [])].filter((u) => allB.has(u));
/** Identifiers or B-only codes in a response. (Stored rows and lists are checked for identifiers only: a refused reading keeps the raw code the A user typed.) */
const leaked = (text: string) => [...idsOfB(text), ...bTokens.filter((t) => text.includes(t))];
let seq = 0;
const n = () => ++seq;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

/* ---------- Fixtures (always filtered by organization: A and B have records with the same names and codes) ---------- */

async function one(q: RawBuilder<{ id: string }>, what: string): Promise<string> {
  const row = (await q.execute(ctx.owner)).rows[0];
  if (!row) throw new Error(`Fixture não encontrada: ${what}`);
  return String(row.id);
}
const inst = (org: 'A' | 'B') => (org === 'A' ? instA : instB);
const sector = (org: 'A' | 'B', code: string) => one(sql`SELECT id FROM sector WHERE institution_id = ${inst(org)} AND code = ${code}`, `setor ${code} de ${org}`);
const unit = (org: 'A' | 'B') => one(sql`SELECT id FROM unit WHERE institution_id = ${inst(org)} ORDER BY name LIMIT 1`, `unidade de ${org}`);
const freeBed = (org: 'A' | 'B', code: string) =>
  one(sql`SELECT b.id FROM bed b JOIN sector s ON s.id = b.sector_id WHERE s.institution_id = ${inst(org)} AND s.code = ${code} AND b.active
    AND b.id NOT IN (SELECT bed_id FROM admission_movement WHERE end_at IS NULL AND bed_id IS NOT NULL) ORDER BY b.code LIMIT 1`, `leito livre ${code} de ${org}`);
const reference = (org: 'A' | 'B') => one(sql`SELECT id FROM clinical_reference WHERE institution_id = ${inst(org)} ORDER BY code LIMIT 1`, `referência de ${org}`);
const user = (org: 'A' | 'B', l: string) => one(sql`SELECT id FROM app_user WHERE institution_id = ${inst(org)} AND login = ${(org === 'B' ? 'hb.' : '') + l}`, `usuário ${l} de ${org}`);
const sterilizer = (org: 'A' | 'B', code: string) => one(sql`SELECT id FROM sterilizer WHERE institution_id = ${inst(org)} AND code = ${code}`, `equipamento ${code} de ${org}`);
const set = (org: 'A' | 'B', code: string) => one(sql`SELECT id FROM instrument_set WHERE institution_id = ${inst(org)} AND code = ${code}`, `caixa ${code} de ${org}`);
const station = (org: 'A' | 'B', name: string) => one(sql`SELECT id FROM scan_station WHERE institution_id = ${inst(org)} AND name = ${name}`, `estação ${name} de ${org}`);
const anyLoad = (org: 'A' | 'B') => one(sql`SELECT id FROM sterilization_load WHERE institution_id = ${inst(org)} ORDER BY code LIMIT 1`, `carga de ${org}`);
const anyOf = (table: 'admission' | 'device_use' | 'surgery' | 'culture' | 'iras_case' | 'procedure_catalog' | 'job_role' | 'professional' | 'training' | 'quality_audit' | 'sterilization_test' | 'instrument_asset', org: 'A' | 'B') =>
  one(sql`SELECT id FROM ${sql.table(table)} WHERE institution_id = ${inst(org)} ORDER BY id LIMIT 1`, `${table} de ${org}`);
const bundleTemplate = (org: 'A' | 'B') => one(sql`SELECT id FROM bundle_template WHERE institution_id = ${inst(org)} AND code = 'bundle-cvc'`, `modelo de bundle de ${org}`);
const bundleItem = (org: 'A' | 'B') =>
  one(sql`SELECT i.id FROM bundle_item i JOIN bundle_template t ON t.id = i.template_id WHERE t.institution_id = ${inst(org)} AND t.code = 'bundle-cvc' AND i.active ORDER BY i.position LIMIT 1`, `item de bundle de ${org}`);
const layout = (org: 'A' | 'B') => one(sql`SELECT id FROM label_layout WHERE institution_id = ${inst(org)} AND entity = 'ativo' AND is_default`, `layout de ${org}`);
const trainingSession = (org: 'A' | 'B') =>
  one(sql`SELECT s.id FROM training_session s JOIN training t ON t.id = s.training_id WHERE t.institution_id = ${inst(org)} ORDER BY s.id LIMIT 1`, `turma de ${org}`);

/** Open admission (with its current sector) of A, admitted more than `hours` ago. */
async function openAdmission(sectorCode: string, hours = 3) {
  const r = await sql<{ id: string; sector_id: string; admitted_at: Date; patient_id: string }>`
    SELECT a.id, m.sector_id, a.admitted_at, a.patient_id FROM admission a JOIN admission_movement m ON m.admission_id = a.id JOIN sector s ON s.id = m.sector_id
    WHERE a.institution_id = ${instA} AND a.discharged_at IS NULL AND m.end_at IS NULL AND s.code = ${sectorCode} AND a.admitted_at < now() - make_interval(hours => ${hours})
    ORDER BY a.admitted_at LIMIT 1`.execute(ctx.owner);
  if (!r.rows[0]) throw new Error(`Fixture não encontrada: internação aberta em ${sectorCode}`);
  return r.rows[0];
}

/* ---------- Requests ---------- */

interface Req { method: 'POST' | 'PUT'; url: string; body?: unknown; headers?: Record<string, string> }
interface Res { statusCode: number; body: string }
const send = (s: Session, r: Req): Promise<Res> =>
  ctx.app.inject({ method: r.method, url: `/api${r.url}`, headers: { ...s.headers, ...r.headers }, ...(r.body !== undefined ? { payload: r.body as object } : {}) });
const json = (r: Res) => JSON.parse(r.body) as Record<string, unknown>;
async function ok(r: Req): Promise<Record<string, unknown>> {
  const res = await send(A, r);
  if (res.statusCode >= 300) throw new Error(`Preparação falhou: ${r.method} ${r.url} → ${res.statusCode} ${res.body}`);
  return json(res);
}

/** Fresh A records that a positive control consumes (each control call gets its own). */
const newAsset = async () => ((await ok({ method: 'POST', url: '/cme/assets', body: { setId: await set('A', 'otica-30'), count: 1, tag: null, justification: J } })).assets as Array<{ id: string; code: string }>)[0]!;
const newPatient = async (admission: object | null) => (await ok({ method: 'POST', url: '/patients', body: { recordNumber: `ISO-${n()}`, initials: 'IS', fullName: null, birthDate: null, sex: 'F', admission } })).id as string;
const plasmaLoad = async (startedAt: string | null, items: object[]) => (await ok({ method: 'POST', url: '/cme/loads', body: { sterilizerId: await sterilizer('A', 'pl1'), program: 'Plasma — ciclo padrão', startedAt, notes: null, reprocessedFromId: null, items } })).id as string;

async function irasBase(kind: 'device' | 'surgery' | 'culture') {
  const q = kind === 'device'
    ? sql<{ admission_id: string; sector_id: string; link: string }>`SELECT d.admission_id, m.sector_id, d.id AS link FROM device_use d JOIN admission a ON a.id = d.admission_id JOIN admission_movement m ON m.admission_id = a.id
        WHERE a.institution_id = ${instA} AND a.discharged_at IS NULL AND m.end_at IS NULL AND d.removed_at IS NULL ORDER BY d.inserted_at LIMIT 1`
    : kind === 'surgery'
      ? sql<{ admission_id: string; sector_id: string; link: string }>`SELECT s.admission_id, s.sector_id, s.id AS link FROM surgery s WHERE s.institution_id = ${instA} ORDER BY s.started_at DESC LIMIT 1`
      : sql<{ admission_id: string; sector_id: string; link: string }>`SELECT c.admission_id, c.sector_id, c.id AS link FROM culture c WHERE c.institution_id = ${instA} ORDER BY c.collected_at DESC LIMIT 1`;
  const row = (await q.execute(ctx.owner)).rows[0];
  if (!row) throw new Error(`Fixture não encontrada: base IRAS (${kind})`);
  return { row, body: { admissionId: row.admission_id, type: 'IPCS', eventDate: today(), sectorId: row.sector_id, description: null, deviceUseId: null, surgeryId: null, cultureIds: [] as string[], justification: J } };
}
const irasLinks = (kind: 'device' | 'surgery' | 'culture', link: string) => (kind === 'device' ? { deviceUseId: link } : kind === 'surgery' ? { surgeryId: link } : { cultureIds: [link] });

async function surgeryBase() {
  const adm = await openAdmission('clinica-cirurgica');
  const start = new Date(Math.max(adm.admitted_at.getTime() + 60_000, Date.now() - 3_600_000));
  return {
    admissionId: adm.id, procedureId: await one(sql`SELECT id FROM procedure_catalog WHERE institution_id = ${instA} AND code = 'herniorrafia-inguinal'`, 'procedimento de A'),
    surgeonId: await one(sql`SELECT id FROM professional WHERE institution_id = ${instA} AND name LIKE 'Cirurgião%' AND active ORDER BY name LIMIT 1`, 'cirurgião de A'),
    sectorId: await sector('A', 'centro-cirurgico'), room: 'Sala 1', startedAt: start.toISOString(), endedAt: new Date(start.getTime() + 40 * 60_000).toISOString(),
    woundClass: 'limpa', asa: 2, implant: false, urgency: false, prophylaxisIndicated: false, prophylaxisDrug: null, prophylaxisDoseAt: null, prophylaxisDurationH: null, redose: null, notes: null,
  };
}

async function templateBody(over: { referenceId?: string; firstItemId?: string }) {
  const t = (await sql<{ id: string; name: string; metric: string | null; method: string; reference_id: string | null; active: boolean; row_version: number }>`
    SELECT id, name, metric, method, reference_id, active, row_version FROM bundle_template WHERE institution_id = ${instA} AND code = 'bundle-cvc'`.execute(ctx.owner)).rows[0]!;
  const items = (await sql<{ id: string; label: string }>`SELECT id, label FROM bundle_item WHERE template_id = ${t.id} AND active ORDER BY position`.execute(ctx.owner)).rows;
  return {
    code: 'bundle-cvc', name: t.name, metric: t.metric, method: t.method, referenceId: over.referenceId ?? t.reference_id, active: t.active,
    items: items.map((i, k) => ({ id: k === 0 && over.firstItemId ? over.firstItemId : i.id, label: i.label })), rowVersion: t.row_version, justification: J,
  };
}
async function bundleAuditBody() {
  const tpl = await bundleTemplate('A');
  const items = (await sql<{ id: string }>`SELECT id FROM bundle_item WHERE template_id = ${tpl} AND active ORDER BY position`.execute(ctx.owner)).rows;
  return { templateId: tpl, sectorId: await sector('A', 'uti-adulto'), admissionId: null as string | null, auditedAt: hoursAgo(1), notes: null, answers: items.map((i) => ({ itemId: i.id, answer: 'conforme' })) };
}
const scanBody = async (over: Record<string, unknown>) => ({
  stationId: await station('A', 'Expurgo — recepção'), code: (await newAsset()).code, inputMethod: 'manual', step: 'recepcao', clientEventId: null, deviceAt: null, outcome: null,
  destinationSectorId: null, originSectorId: null, loadId: null, packaging: null, justification: null, override: false, ...over,
});
const looseBody = async (over: Record<string, unknown>) => ({ stationId: await station('A', 'Expurgo — recepção'), description: 'Material avulso (isolamento)', setId: null, originSectorId: null, clientEventId: null, ...over });
async function stationPut(field: 'sectorId' | 'responsibleUserId', id: string): Promise<Req> {
  const target = await station('A', 'Devoluções');
  const st = ((await ctx.app.inject({ url: '/api/cme/stations', headers: A.headers })).json().stations as Array<Record<string, unknown>>).find((s) => s.id === target)!;
  const body = {
    sectorId: st.sectorId, name: st.name, location: st.location, steps: st.steps, inputMethods: st.inputMethods, symbologies: st.symbologies, deviceLabel: st.deviceLabel,
    responsibleUserId: st.responsibleUserId, requirePairing: st.requirePairing, scanConfig: st.scanConfig, enabled: st.enabled, rowVersion: st.rowVersion, justification: J, [field]: id,
  };
  return { method: 'PUT', url: `/cme/stations/${target}`, body };
}
const stationPost = async (over: Record<string, unknown>): Promise<Req> => ({
  method: 'POST', url: '/cme/stations', body: {
    sectorId: await sector('A', 'cme'), name: `Estação isolamento ${n()}`, location: null, steps: ['limpeza'], inputMethods: ['manual'], symbologies: [], deviceLabel: null, responsibleUserId: null,
    requirePairing: false, scanConfig: { maxKeyIntervalMs: 35, minLength: 6, terminator: 'enter' }, enabled: true, rowVersion: null, justification: J, ...over,
  },
});
async function usableLabel() {
  return (await sql<{ label_code: string }>`
    SELECT i.label_code FROM load_item i JOIN sterilization_load l ON l.id = i.load_id
    WHERE i.institution_id = ${instA} AND l.status = 'liberada' AND i.process_id IS NULL AND (i.expires_on IS NULL OR i.expires_on > current_date + 1)
      AND NOT EXISTS (SELECT 1 FROM material_use u WHERE u.item_id = i.id)
      AND NOT EXISTS (SELECT 1 FROM load_release_decision d WHERE d.load_id = l.id AND d.from_status = 'liberada')
    ORDER BY l.started_at DESC, i.position LIMIT 1`.execute(ctx.owner)).rows[0]!.label_code;
}
async function newIrasCase(kind: 'device' | 'surgery' | 'culture') {
  const base = await irasBase(kind);
  const id = (await ok({ method: 'POST', url: '/iras', body: { ...base.body, ...irasLinks(kind, base.row.link) } })).id as string;
  return { id, base };
}

/* ---------- Cases: one identifier field at a time ---------- */

interface Case {
  route: string;
  field: string;
  foreign: () => Promise<string>;
  own: () => Promise<string>;
  build: (id: string) => Promise<Req>;
  /** Readings are recorded even when refused (200 with a refusal result): accepted means a reading that moved the flow. */
  accepted?: (res: Res) => boolean;
}
const reading = (res: Res) => res.statusCode === 200 && ['aceita', 'excecao_autorizada'].includes(String(json(res).result));

const cases: Case[] = [
  /* Organization, users and configuration */
  { route: 'POST /org/sectors', field: 'unitId', foreign: () => unit('B'), own: () => unit('A'), build: async (id) => ({ method: 'POST', url: '/org/sectors', body: { unitId: id, code: `iso-setor-${n()}`, name: `Setor isolamento ${seq}`, kind: 'apoio', justification: J } }) },
  {
    route: 'PUT /org/sectors/:id', field: 'unitId', foreign: () => unit('B'), own: async () => one(sql`SELECT unit_id AS id FROM sector WHERE institution_id = ${instA} AND code = 'cme'`, 'unidade da CME de A'),
    build: async (id) => {
      const s = (await sql<{ id: string; name: string; kind: string; row_version: number }>`SELECT id, name, kind, row_version FROM sector WHERE institution_id = ${instA} AND code = 'cme'`.execute(ctx.owner)).rows[0]!;
      return { method: 'PUT', url: `/org/sectors/${s.id}`, body: { unitId: id, name: s.name, kind: s.kind, active: true, rowVersion: s.row_version, justification: J } };
    },
  },
  { route: 'POST /users', field: 'sectorIds[]', foreign: () => sector('B', 'uti-adulto'), own: () => sector('A', 'uti-adulto'), build: async (id) => ({ method: 'POST', url: '/users', body: accessBody({ login: `iso.usuario${n()}`, displayName: 'Usuário isolamento', functionRole: 'enf_ccih', scopeAll: false, sectorIds: [id] }) }) },
  { route: 'POST /users', field: 'supervisorId', foreign: () => user('B', 'cme'), own: () => user('A', 'cme'), build: async (id) => ({ method: 'POST', url: '/users', body: accessBody({ login: `iso.usuario${n()}`, displayName: 'Usuário isolamento', functionRole: 'enf_ccih', supervisorId: id }) }) },
  ...(['sectorIds', 'supervisorId'] as const).map((field): Case => ({
    route: 'PUT /users/:id', field: field === 'sectorIds' ? 'sectorIds[]' : field,
    foreign: () => (field === 'sectorIds' ? sector('B', 'uti-adulto') : user('B', 'cme')), own: () => (field === 'sectorIds' ? sector('A', 'uti-adulto') : user('A', 'cme')),
    build: async (id) => {
      const u = (await sql<{ id: string; row_version: number }>`SELECT id, row_version FROM app_user WHERE institution_id = ${instA} AND login = 'gestor'`.execute(ctx.owner)).rows[0]!;
      const access = field === 'sectorIds' ? { scopeAll: false, sectorIds: [id] } : { supervisorId: id };
      return { method: 'PUT', url: `/users/${u.id}`, body: accessBody({ displayName: 'Gestor (isolamento)', functionRole: 'gestor', rowVersion: u.row_version, ...access }) };
    },
  })),
  {
    route: 'PUT /config/targets/:indicatorId', field: 'referenceId', foreign: () => reference('B'), own: () => reference('A'),
    build: async (id) => {
      const t = (await sql<{ row_version: number }>`SELECT row_version FROM indicator_target WHERE institution_id = ${instA} AND indicator_id = 'di-ipcs'`.execute(ctx.owner)).rows[0];
      return { method: 'PUT', url: '/config/targets/di-ipcs', body: { value: 2, warningBand: null, referenceId: id, rowVersion: t?.row_version ?? null, justification: J } };
    },
  },
  {
    route: 'PUT /config/rules/:key', field: 'referenceId', foreign: () => reference('B'), own: () => reference('A'),
    build: async (id) => {
      const r = (await sql<{ row_version: number }>`SELECT row_version FROM rule_parameter WHERE institution_id = ${instA} AND key = 'surgery.prophylaxisWindowMin'`.execute(ctx.owner)).rows[0];
      return { method: 'PUT', url: '/config/rules/surgery.prophylaxisWindowMin', body: { value: 60, referenceId: id, rowVersion: r?.row_version ?? null, justification: J } };
    },
  },
  {
    route: 'PUT /config/load-release-policy', field: 'referenceId', foreign: () => reference('B'), own: () => reference('A'),
    build: async (id) => {
      const p = (await sql<{ required_tests: string[]; require_daily_bowie_dick: boolean; hold_implants_until_biological: boolean; row_version: number }>`
        SELECT required_tests, require_daily_bowie_dick, hold_implants_until_biological, row_version FROM load_release_policy WHERE institution_id = ${instA}`.execute(ctx.owner)).rows[0]!;
      return { method: 'PUT', url: '/config/load-release-policy', body: { requiredLoadTests: p.required_tests, requireDailyBowieDick: p.require_daily_bowie_dick, holdImplantsUntilBiological: p.hold_implants_until_biological, referenceId: id, rowVersion: p.row_version, justification: J } };
    },
  },

  /* Quality, training and supplies */
  { route: 'PUT /bundles/templates', field: 'referenceId', foreign: () => reference('B'), own: () => reference('A'), build: async (id) => ({ method: 'PUT', url: '/bundles/templates', body: await templateBody({ referenceId: id }) }) },
  { route: 'PUT /bundles/templates', field: 'items[].id', foreign: () => bundleItem('B'), own: () => bundleItem('A'), build: async (id) => ({ method: 'PUT', url: '/bundles/templates', body: await templateBody({ firstItemId: id }) }) },
  { route: 'POST /bundles/audits', field: 'templateId', foreign: () => bundleTemplate('B'), own: () => bundleTemplate('A'), build: async (id) => ({ method: 'POST', url: '/bundles/audits', body: { ...(await bundleAuditBody()), templateId: id } }) },
  { route: 'POST /bundles/audits', field: 'sectorId', foreign: () => sector('B', 'uti-adulto'), own: () => sector('A', 'uti-adulto'), build: async (id) => ({ method: 'POST', url: '/bundles/audits', body: { ...(await bundleAuditBody()), sectorId: id } }) },
  { route: 'POST /bundles/audits', field: 'admissionId', foreign: () => anyOf('admission', 'B'), own: async () => (await openAdmission('uti-adulto')).id, build: async (id) => ({ method: 'POST', url: '/bundles/audits', body: { ...(await bundleAuditBody()), admissionId: id } }) },
  {
    route: 'POST /bundles/audits', field: 'answers[].itemId', foreign: () => bundleItem('B'), own: () => bundleItem('A'),
    build: async (id) => {
      const b = await bundleAuditBody();
      return { method: 'POST', url: '/bundles/audits', body: { ...b, answers: b.answers.map((a, k) => (k === 0 ? { ...a, itemId: id } : a)) } };
    },
  },
  { route: 'POST /hand-hygiene', field: 'sectorId', foreign: () => sector('B', 'uti-adulto'), own: () => sector('A', 'uti-adulto'), build: async (id) => ({ method: 'POST', url: '/hand-hygiene', body: { sectorId: id, observedAt: hoursAgo(1), category: 'enfermagem', opportunities: 10, actions: 8 } }) },
  { route: 'POST /quality/audits', field: 'sectorId', foreign: () => sector('B', 'clinica-medica'), own: () => sector('A', 'clinica-medica'), build: async (id) => ({ method: 'POST', url: '/quality/audits', body: { title: `Auditoria isolamento ${n()}`, kind: 'processo', sectorId: id, scope: null, plannedFor: today(), justification: J } }) },
  {
    route: 'POST /quality/nonconformities', field: 'auditId', foreign: () => anyOf('quality_audit', 'B'),
    own: async () => (await ok({ method: 'POST', url: '/quality/audits', body: { title: `Auditoria isolamento ${n()}`, kind: 'processo', sectorId: null, scope: null, plannedFor: today(), justification: J } })).id as string,
    build: async (id) => ({ method: 'POST', url: '/quality/nonconformities', body: { auditId: id, sectorId: null, origin: 'auditoria', severity: 'media', description: 'NC de isolamento', detectedOn: today(), justification: J } }),
  },
  { route: 'POST /quality/nonconformities', field: 'sectorId', foreign: () => sector('B', 'cme'), own: () => sector('A', 'cme'), build: async (id) => ({ method: 'POST', url: '/quality/nonconformities', body: { auditId: null, sectorId: id, origin: 'outro', severity: 'baixa', description: 'NC de isolamento', detectedOn: today(), justification: J } }) },
  ...(['jobRoleId', 'sectorId'] as const).map((field): Case => ({
    route: 'POST /staff', field, foreign: () => (field === 'jobRoleId' ? anyOf('job_role', 'B') : sector('B', 'uti-adulto')), own: () => (field === 'jobRoleId' ? anyOf('job_role', 'A') : sector('A', 'uti-adulto')),
    build: async (id) => ({ method: 'POST', url: '/staff', body: { name: `Profissional isolamento ${n()}`, registration: null, jobRoleId: await anyOf('job_role', 'A'), sectorId: await sector('A', 'uti-adulto'), justification: J, [field]: id } }),
  })),
  {
    route: 'PUT /trainings', field: 'targetJobRoleIds[]', foreign: () => anyOf('job_role', 'B'), own: () => anyOf('job_role', 'A'),
    build: async (id) => ({ method: 'PUT', url: '/trainings', body: { id: null, title: `Treinamento isolamento ${n()}`, theme: 'Isolamento', mandatory: true, validityMonths: 12, targetJobRoleIds: [id], description: null, active: true, rowVersion: null, justification: J } }),
  },
  {
    route: 'PUT /trainings', field: 'id', foreign: () => anyOf('training', 'B'), own: () => one(sql`SELECT id FROM training WHERE institution_id = ${instA} ORDER BY title LIMIT 1`, 'treinamento de A'),
    build: async (id) => {
      const t = (await sql<{ title: string; theme: string; mandatory: boolean; validity_months: number | null; target_job_role_ids: string[]; description: string | null; active: boolean; row_version: number }>`
        SELECT title, theme, mandatory, validity_months, target_job_role_ids, description, active, row_version FROM training WHERE institution_id = ${instA} ORDER BY title LIMIT 1`.execute(ctx.owner)).rows[0]!;
      return { method: 'PUT', url: '/trainings', body: { id, title: t.title, theme: t.theme, mandatory: t.mandatory, validityMonths: t.validity_months, targetJobRoleIds: t.target_job_role_ids, description: t.description, active: t.active, rowVersion: t.row_version, justification: J } };
    },
  },
  ...(['sectorId', 'attendees[].professionalId'] as const).map((field): Case => ({
    route: 'POST /trainings/:id/sessions', field,
    foreign: () => (field === 'sectorId' ? sector('B', 'uti-adulto') : anyOf('professional', 'B')), own: () => (field === 'sectorId' ? sector('A', 'uti-adulto') : anyOf('professional', 'A')),
    build: async (id) => {
      const training = await one(sql`SELECT id FROM training WHERE institution_id = ${instA} AND active ORDER BY title LIMIT 1`, 'treinamento ativo de A');
      const professionalId = field === 'sectorId' ? await anyOf('professional', 'A') : id;
      return { method: 'POST', url: `/trainings/${training}/sessions`, body: { heldOn: today(), instructor: 'Equipe CCIH', hours: 1, sectorId: field === 'sectorId' ? id : null, notes: null, attendees: [{ professionalId, present: true, score: null }] } };
    },
  })),
  {
    route: 'POST /supplies/:id/movements', field: 'sectorId', foreign: () => sector('B', 'uti-adulto'), own: () => sector('A', 'uti-adulto'),
    build: async (id) => ({ method: 'POST', url: `/supplies/${await one(sql`SELECT id FROM supply WHERE institution_id = ${instA} ORDER BY code LIMIT 1`, 'insumo de A')}/movements`, body: { kind: 'entrada', lot: `ISO-${n()}`, expiresOn: '2030-12-31', quantity: 1, sectorId: id, occurredAt: hoursAgo(1), reason: null } }),
  },

  /* Patients, admissions and notes */
  { route: 'POST /patients', field: 'admission.sectorId', foreign: () => sector('B', 'uti-adulto'), own: () => sector('A', 'uti-adulto'), build: async (id) => ({ method: 'POST', url: '/patients', body: { recordNumber: `ISO-${n()}`, initials: 'IS', fullName: null, birthDate: null, sex: 'F', admission: { admittedAt: hoursAgo(5), sectorId: id, bedId: null, diagnosis: null } } }) },
  { route: 'POST /patients', field: 'admission.bedId', foreign: () => freeBed('B', 'uti-adulto'), own: () => freeBed('A', 'uti-adulto'), build: async (id) => ({ method: 'POST', url: '/patients', body: { recordNumber: `ISO-${n()}`, initials: 'IS', fullName: null, birthDate: null, sex: 'F', admission: { admittedAt: hoursAgo(5), sectorId: await sector('A', 'uti-adulto'), bedId: id, diagnosis: null } } }) },
  ...(['sectorId', 'bedId'] as const).map((field): Case => ({
    route: 'POST /patients/:id/admissions', field, foreign: () => (field === 'sectorId' ? sector('B', 'clinica-medica') : freeBed('B', 'clinica-medica')), own: () => (field === 'sectorId' ? sector('A', 'clinica-medica') : freeBed('A', 'clinica-medica')),
    build: async (id) => ({ method: 'POST', url: `/patients/${await newPatient(null)}/admissions`, body: { admittedAt: hoursAgo(5), sectorId: field === 'sectorId' ? id : await sector('A', 'clinica-medica'), bedId: field === 'bedId' ? id : null, diagnosis: null } }),
  })),
  ...(['sectorId', 'bedId'] as const).map((field): Case => ({
    route: 'POST /admissions/:id/transfer', field, foreign: () => (field === 'sectorId' ? sector('B', 'clinica-medica') : freeBed('B', 'clinica-medica')), own: () => (field === 'sectorId' ? sector('A', 'clinica-medica') : freeBed('A', 'clinica-medica')),
    build: async (id) => {
      const patient = await newPatient({ admittedAt: hoursAgo(5), sectorId: await sector('A', 'uti-adulto'), bedId: null, diagnosis: null });
      const adm = (await sql<{ id: string; row_version: number }>`SELECT id, row_version FROM admission WHERE patient_id = ${patient}`.execute(ctx.owner)).rows[0]!;
      return { method: 'POST', url: `/admissions/${adm.id}/transfer`, body: { at: hoursAgo(1), sectorId: field === 'sectorId' ? id : await sector('A', 'clinica-medica'), bedId: field === 'bedId' ? id : null, reason: null, rowVersion: adm.row_version } };
    },
  })),
  ...(['admissionId', 'caseId'] as const).map((field): Case => ({
    route: 'POST /patients/:id/notes', field,
    foreign: () => anyOf(field === 'admissionId' ? 'admission' : 'iras_case', 'B'),
    own: async () => one(sql`SELECT ${sql.ref(field === 'admissionId' ? 'a.id' : 'c.id')} AS id FROM iras_case c JOIN admission a ON a.id = c.admission_id WHERE c.institution_id = ${instA} ORDER BY c.id LIMIT 1`, 'caso de A'),
    build: async (id) => {
      const patient = await one(sql`SELECT a.patient_id AS id FROM iras_case c JOIN admission a ON a.id = c.admission_id WHERE c.institution_id = ${instA} ORDER BY c.id LIMIT 1`, 'paciente de A com caso');
      return { method: 'POST', url: `/patients/${patient}/notes`, body: { kind: 'avaliacao', body: 'Evolução de isolamento.', admissionId: field === 'admissionId' ? id : null, caseId: field === 'caseId' ? id : null } };
    },
  })),

  /* Surgery, microbiology and IRAS */
  ...(['admissionId', 'procedureId', 'surgeonId', 'sectorId'] as const).map((field): Case => ({
    route: 'POST /surgeries', field,
    foreign: () => (field === 'admissionId' ? anyOf('admission', 'B') : field === 'procedureId' ? anyOf('procedure_catalog', 'B') : field === 'surgeonId' ? anyOf('professional', 'B') : sector('B', 'centro-cirurgico')),
    own: async () => (await surgeryBase())[field],
    build: async (id) => ({ method: 'POST', url: '/surgeries', body: { ...(await surgeryBase()), [field]: id } }),
  })),
  ...(['procedureId', 'surgeonId', 'sectorId'] as const).map((field): Case => ({
    route: 'PUT /surgeries/:id', field,
    foreign: () => (field === 'procedureId' ? anyOf('procedure_catalog', 'B') : field === 'surgeonId' ? anyOf('professional', 'B') : sector('B', 'centro-cirurgico')),
    own: async () => (await surgeryBase())[field],
    build: async (id) => {
      const base = await surgeryBase();
      const created = (await ok({ method: 'POST', url: '/surgeries', body: base })).id as string;
      const { admissionId: _admission, ...fields } = base;
      return { method: 'PUT', url: `/surgeries/${created}`, body: { ...fields, rowVersion: 1, justification: J, [field]: id } };
    },
  })),
  ...(['admissionId', 'sectorId'] as const).map((field): Case => ({
    route: 'POST /cultures', field, foreign: () => (field === 'admissionId' ? anyOf('admission', 'B') : sector('B', 'uti-adulto')),
    own: async () => (field === 'admissionId' ? (await openAdmission('uti-adulto')).id : sector('A', 'uti-adulto')),
    build: async (id) => {
      const adm = await openAdmission('uti-adulto');
      return { method: 'POST', url: '/cultures', body: { admissionId: adm.id, sectorId: adm.sector_id, material: 'sangue', collectedAt: hoursAgo(1), [field]: id } };
    },
  })),
  { route: 'POST /iras', field: 'admissionId', foreign: () => anyOf('admission', 'B'), own: async () => (await irasBase('device')).row.admission_id, build: async (id) => ({ method: 'POST', url: '/iras', body: { ...(await irasBase('device')).body, admissionId: id } }) },
  { route: 'POST /iras', field: 'sectorId', foreign: () => sector('B', 'uti-adulto'), own: async () => (await irasBase('device')).row.sector_id, build: async (id) => ({ method: 'POST', url: '/iras', body: { ...(await irasBase('device')).body, sectorId: id } }) },
  ...([['device', 'deviceUseId', 'device_use'], ['surgery', 'surgeryId', 'surgery'], ['culture', 'cultureIds[]', 'culture']] as const).flatMap(([kind, field, table]): Case[] => [
    {
      route: 'POST /iras', field, foreign: () => anyOf(table, 'B'), own: async () => (await irasBase(kind)).row.link,
      build: async (id) => ({ method: 'POST', url: '/iras', body: { ...(await irasBase(kind)).body, ...irasLinks(kind, id) } }),
    },
    {
      route: 'PUT /iras/:id', field, foreign: () => anyOf(table, 'B'), own: async () => (await irasBase(kind)).row.link,
      build: async (id) => {
        const { id: caseId, base } = await newIrasCase(kind);
        const { admissionId: _admission, justification: _j, ...fields } = base.body;
        return { method: 'PUT', url: `/iras/${caseId}`, body: { ...fields, ...irasLinks(kind, id), rowVersion: 1, justification: J } };
      },
    },
  ]),
  {
    route: 'PUT /iras/:id', field: 'sectorId', foreign: () => sector('B', 'uti-adulto'), own: async () => (await irasBase('device')).row.sector_id,
    build: async (id) => {
      const { id: caseId, base } = await newIrasCase('device');
      const { admissionId: _admission, justification: _j, ...fields } = base.body;
      return { method: 'PUT', url: `/iras/${caseId}`, body: { ...fields, deviceUseId: base.row.link, sectorId: id, rowVersion: 1, justification: J } };
    },
  },
  {
    route: 'POST /iras/:id/status', field: 'criterionReferenceId', foreign: () => reference('B'), own: () => reference('A'),
    build: async (id) => ({ method: 'POST', url: `/iras/${(await newIrasCase('device')).id}/status`, body: { to: 'descartada', justification: J, criterionReferenceId: id, deviceAssociated: null, rowVersion: 1 } }),
  },

  /* CME: equipment, loads, tests and uses */
  {
    route: 'POST /cme/sterilizers', field: 'sectorId', foreign: () => sector('B', 'cme'), own: () => sector('A', 'cme'),
    build: async (id) => ({ method: 'POST', url: '/cme/sterilizers', body: { code: `iso${n()}`, name: `Autoclave isolamento ${seq}`, type: 'vapor_prevacuo', serial: null, sectorId: id, status: 'ativo', statusReason: null, qualificationDueOn: null, rowVersion: null, justification: J } }),
  },
  {
    route: 'PUT /cme/sterilizers/:id', field: 'sectorId', foreign: () => sector('B', 'cme'), own: () => sector('A', 'cme'),
    build: async (id) => {
      const target = await sterilizer('A', 'av1');
      const s = ((await ctx.app.inject({ url: '/api/cme/sterilizers', headers: A.headers })).json().sterilizers as Array<Record<string, unknown>>).find((x) => x.id === target)!;
      return { method: 'PUT', url: `/cme/sterilizers/${target}`, body: { code: s.code, name: s.name, type: s.type, serial: s.serial, sectorId: id, status: s.status, statusReason: s.statusReason, qualificationDueOn: s.qualificationDueOn, rowVersion: s.rowVersion, justification: J } };
    },
  },
  { route: 'POST /cme/loads', field: 'sterilizerId', foreign: () => sterilizer('B', 'pl1'), own: () => sterilizer('A', 'pl1'), build: async (id) => ({ method: 'POST', url: '/cme/loads', body: { sterilizerId: id, program: 'Plasma — ciclo padrão', startedAt: null, notes: null, reprocessedFromId: null, items: [] } }) },
  {
    route: 'POST /cme/loads', field: 'items[].setId', foreign: () => set('B', 'otica-30'), own: () => set('A', 'otica-30'),
    build: async (id) => ({ method: 'POST', url: '/cme/loads', body: { sterilizerId: await sterilizer('A', 'pl1'), program: 'Plasma — ciclo padrão', startedAt: null, notes: null, reprocessedFromId: null, items: [{ setId: id, description: null, quantity: 1, packaging: null, implant: null }] } }),
  },
  {
    route: 'POST /cme/loads', field: 'reprocessedFromId',
    foreign: () => one(sql`SELECT id FROM sterilization_load WHERE institution_id = ${instB} AND status IN ('reprocessamento', 'rejeitada') ORDER BY code LIMIT 1`, 'carga de B a reprocessar'),
    own: async () => {
      const id = await plasmaLoad(null, []);
      await ok({ method: 'POST', url: `/cme/loads/${id}/decision`, body: { status: 'reprocessamento', justification: J, rowVersion: 1 } });
      return id;
    },
    build: async (id) => ({ method: 'POST', url: '/cme/loads', body: { sterilizerId: await sterilizer('A', 'pl1'), program: 'Plasma — ciclo padrão', startedAt: null, notes: null, reprocessedFromId: id, items: [] } }),
  },
  {
    route: 'POST /cme/tests', field: 'sterilizerId', foreign: () => sterilizer('B', 'av1'), own: () => sterilizer('A', 'av1'),
    build: async (id) => ({ method: 'POST', url: '/cme/tests', body: { sterilizerId: id, loadId: null, type: 'BOWIE_DICK', result: 'aprovado', performedAt: minutesAgo(1), indicatorLot: 'BD-ISO', indicatorExpiry: '2099-12-31', incubationStart: null, readAt: null, controlResult: null, notes: null } }),
  },
  {
    route: 'POST /cme/tests', field: 'loadId', foreign: () => anyLoad('B'), own: () => plasmaLoad(minutesAgo(90), [{ setId: null, description: 'Pinça avulsa', quantity: 1, packaging: 'papel_grau_cirurgico', implant: false }]),
    build: async (id) => ({ method: 'POST', url: '/cme/tests', body: { sterilizerId: null, loadId: id, type: 'IQ5', result: 'aprovado', performedAt: minutesAgo(1), indicatorLot: 'IQ-ISO', indicatorExpiry: '2099-12-31', incubationStart: null, readAt: null, controlResult: null, notes: null } }),
  },
  { route: 'POST /cme/uses', field: 'sectorId', foreign: () => sector('B', 'uti-adulto'), own: () => sector('A', 'uti-adulto'), build: async (id) => ({ method: 'POST', url: '/cme/uses', body: { labelCode: await usableLabel(), sectorId: id, usedAt: minutesAgo(5) } }) },
  { route: 'POST /cme/assets', field: 'setId', foreign: () => set('B', 'otica-30'), own: () => set('A', 'otica-30'), build: async (id) => ({ method: 'POST', url: '/cme/assets', body: { setId: id, count: 1, tag: null, justification: J } }) },

  /* CME: stations, readings and labels */
  { route: 'POST /cme/stations', field: 'sectorId', foreign: () => sector('B', 'cme'), own: () => sector('A', 'cme'), build: (id) => stationPost({ sectorId: id }) },
  { route: 'POST /cme/stations', field: 'responsibleUserId', foreign: () => user('B', 'cme'), own: () => user('A', 'cme'), build: (id) => stationPost({ responsibleUserId: id }) },
  { route: 'PUT /cme/stations/:id', field: 'sectorId', foreign: () => sector('B', 'cme'), own: () => sector('A', 'cme'), build: (id) => stationPut('sectorId', id) },
  { route: 'PUT /cme/stations/:id', field: 'responsibleUserId', foreign: () => user('B', 'cme'), own: () => user('A', 'cme'), build: (id) => stationPut('responsibleUserId', id) },
  { route: 'POST /cme/scan', field: 'stationId', foreign: () => station('B', 'Expurgo — recepção'), own: () => station('A', 'Expurgo — recepção'), build: async (id) => ({ method: 'POST', url: '/cme/scan', body: await scanBody({ stationId: id }) }), accepted: reading },
  { route: 'POST /cme/scan', field: 'loadId', foreign: () => anyLoad('B'), own: () => anyLoad('A'), build: async (id) => ({ method: 'POST', url: '/cme/scan', body: await scanBody({ loadId: id }) }), accepted: reading },
  { route: 'POST /cme/scan', field: 'originSectorId', foreign: () => sector('B', 'centro-cirurgico'), own: () => sector('A', 'centro-cirurgico'), build: async (id) => ({ method: 'POST', url: '/cme/scan', body: await scanBody({ originSectorId: id }) }), accepted: reading },
  { route: 'POST /cme/scan', field: 'destinationSectorId', foreign: () => sector('B', 'centro-cirurgico'), own: () => sector('A', 'centro-cirurgico'), build: async (id) => ({ method: 'POST', url: '/cme/scan', body: await scanBody({ destinationSectorId: id }) }), accepted: reading },
  { route: 'POST /cme/scan', field: 'code (asset code)', foreign: async () => bTokens[0]!, own: async () => (await newAsset()).code, build: async (code) => ({ method: 'POST', url: '/cme/scan', body: await scanBody({ code }) }), accepted: reading },
  {
    route: 'POST /cme/scan', field: 'code (process code)', foreign: async () => bTokens[1]!,
    own: async () => (((await ok({ method: 'POST', url: '/cme/processes/loose', body: await looseBody({}) })).process as { code: string }).code),
    build: async (code) => ({ method: 'POST', url: '/cme/scan', body: { ...(await scanBody({ code })), stationId: await station('A', 'Limpeza'), step: 'limpeza' } }), accepted: reading,
  },
  { route: 'POST /cme/processes/loose', field: 'stationId', foreign: () => station('B', 'Expurgo — recepção'), own: () => station('A', 'Expurgo — recepção'), build: async (id) => ({ method: 'POST', url: '/cme/processes/loose', body: await looseBody({ stationId: id }) }) },
  { route: 'POST /cme/processes/loose', field: 'setId', foreign: () => set('B', 'otica-30'), own: () => set('A', 'otica-30'), build: async (id) => ({ method: 'POST', url: '/cme/processes/loose', body: await looseBody({ setId: id }) }) },
  { route: 'POST /cme/processes/loose', field: 'originSectorId', foreign: () => sector('B', 'centro-cirurgico'), own: () => sector('A', 'centro-cirurgico'), build: async (id) => ({ method: 'POST', url: '/cme/processes/loose', body: await looseBody({ originSectorId: id }) }) },
  {
    route: 'POST /cme/labels/print', field: 'ids[]', foreign: () => anyOf('instrument_asset', 'B'), own: async () => (await newAsset()).id,
    build: async (id) => ({ method: 'POST', url: '/cme/labels/print', body: { entity: 'ativo', ids: [id], layoutId: await layout('A'), output: 'zpl', mode: 'impressao', reason: null } }),
  },
  {
    route: 'POST /cme/labels/print', field: 'layoutId', foreign: () => layout('B'), own: () => layout('A'),
    build: async (id) => ({ method: 'POST', url: '/cme/labels/print', body: { entity: 'ativo', ids: [(await newAsset()).id], layoutId: id, output: 'navegador', mode: 'impressao', reason: null } }),
  },

  /* Query string of a write route */
  ...([['sterilization_test', () => anyOf('sterilization_test', 'B'), () => anyOf('sterilization_test', 'A')], ['training_session', () => trainingSession('B'), () => trainingSession('A')]] as const).map(([entity, foreign, own]): Case => ({
    route: 'POST /attachments', field: `?entityId (${entity})`, foreign, own,
    build: async (id) => ({ method: 'POST', url: `/attachments?entity=${entity}&entityId=${id}`, body: PNG, headers: { 'content-type': 'image/png', 'x-file-name': 'isolamento.png' } }),
  })),
];

/* ---------- Database checks ---------- */

/** Every row written (inserted or updated) after transaction `since`, as text, by table. */
async function writtenSince(since: string): Promise<Array<{ t: string; r: string }>> {
  const parts = tables.map((t) => sql`SELECT ${t}::text AS t, x::text AS r FROM ${sql.table(t)} x WHERE x.xmin::text::bigint > ${since}::bigint`);
  return (await sql<{ t: string; r: string }>`${sql.join(parts, sql` UNION ALL `)}`.execute(ctx.owner)).rows;
}
const currentXid = async () => (await sql<{ x: string }>`SELECT (txid_current() % 4294967296)::text AS x`.execute(ctx.owner)).rows[0]!.x;
/** Tables that legitimately keep the caller's own trail (refused attempts, sessions, realtime events). */
const TRAIL = new Set(['audit_log', 'session', 'event_outbox']);

async function bRows(): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const t of tables) {
    if (t === 'session' || t === 'event_outbox') continue;
    const rows = (await sql<{ r: string }>`SELECT x::text AS r FROM ${sql.table(t)} x`.execute(ctx.owner)).rows.map((x) => x.r).filter((r) => idsOfB(r).length);
    out.set(t, new Set(rows));
  }
  return out;
}

beforeAll(async () => {
  ctx = await setupTestApp({ API_RATE_LIMIT_PER_MINUTE: '100000', UPLOAD_DIR: uploads });
  instA = ctx.institutionId;
  tables = (await sql<{ table_name: string }>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name NOT LIKE 'kysely_%' ORDER BY 1`.execute(ctx.owner)).rows.map((r) => r.table_name);
  const uuidTables = (await sql<{ table_name: string }>`
    SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
    WHERE c.table_schema = 'public' AND c.column_name = 'id' AND t.table_type = 'BASE TABLE' AND c.data_type = 'uuid' ORDER BY 1`.execute(ctx.owner)).rows.map((r) => r.table_name);
  const ids = async () => {
    const all = new Set<string>();
    for (const t of uuidTables) for (const r of (await sql<{ id: string }>`SELECT id::text AS id FROM ${sql.table(t)}`.execute(ctx.owner)).rows) all.add(r.id);
    return all;
  };
  const before = await ids();
  const b = await seedDemo(ctx.db, { password: TEST_PASSWORD, additional: { loginPrefix: 'hb.', name: 'Hospital B (teste de isolamento)' } });
  instB = b.institutionId;
  // Records only B has, made through B's own API: random codes that cannot collide with A's.
  const hb = await login(ctx.app, 'hb.admin');
  const bSet = await one(sql`SELECT id FROM instrument_set WHERE institution_id = ${instB} AND code = 'otica-30'`, 'caixa de B');
  const asset = await send(hb, { method: 'POST', url: '/cme/assets', body: { setId: bSet, count: 1, tag: null, justification: J } });
  const bStation = await one(sql`SELECT id FROM scan_station WHERE institution_id = ${instB} AND name = 'Expurgo — recepção'`, 'estação de B');
  const loose = await send(hb, { method: 'POST', url: '/cme/processes/loose', body: { stationId: bStation, description: 'Material avulso de B', setId: null, originSectorId: null, clientEventId: null } });
  if (asset.statusCode !== 201 || loose.statusCode !== 201) throw new Error(`Preparação de B falhou: ${asset.body} ${loose.body}`);
  bTokens.push((json(asset).assets as Array<{ code: string }>)[0]!.code, (json(loose).process as { code: string }).code);
  for (const id of await ids()) if (!before.has(id)) allB.add(id);
  allB.add(instB);
  A = await login(ctx.app, 'admin');
  bRowsBefore = await bRows();
}, 180_000);
afterAll(async () => {
  await teardown(ctx);
  rmSync(uploads, { recursive: true, force: true });
});

describe('isolation between organizations: identifiers of B inside bodies and query strings of write routes', () => {
  it('organization B exists with its own records and B-only codes', () => {
    expect(instB).not.toBe(instA);
    expect(allB.size).toBeGreaterThan(1000);
    expect(bTokens).toHaveLength(2);
  });

  const summary: string[] = [];
  for (const c of cases) {
    it(`${c.route} · ${c.field}`, async () => {
      const accepted = c.accepted ?? ((r: Res) => r.statusCode >= 200 && r.statusCode < 300);
      const foreignId = await c.foreign();
      expect(allB.has(foreignId) || bTokens.includes(foreignId), 'the foreign identifier belongs to B').toBe(true);
      const req = await c.build(foreignId);
      const since = await currentXid();
      const res = await send(A, req);
      const written = (await writtenSince(since)).filter((w) => !TRAIL.has(w.t) && idsOfB(w.r).length);
      const own = await send(A, await c.build(await c.own()));
      summary.push(`${c.route} · ${c.field}: B → ${res.statusCode}${c.accepted ? ` (${String(json(res).result ?? json(res).error)})` : ''}; A → ${own.statusCode}`);
      expect(accepted(own), `positive control with A's identifier: ${own.statusCode} ${own.body}`).toBe(true);
      expect.soft(accepted(res), `accepted B's identifier: ${res.statusCode} ${res.body}`).toBe(false);
      expect.soft(leaked(res.body), 'response mentions B').toEqual([]);
      expect.soft(written.map((w) => `${w.t}: ${w.r.slice(0, 300)}`), 'rows written that reference B').toEqual([]);
    });
  }

  it('leaves every row of B untouched and nothing of B reachable through the read routes of A', async () => {
    const after = await bRows();
    const problems: string[] = [];
    for (const [t, rows] of bRowsBefore) for (const r of rows) if (!after.get(t)!.has(r)) problems.push(`linha de B alterada ou apagada em ${t}`);
    const SKIP = new Set(['/api/events', '/api/auth/logout', '/api/health', '/api/ready']);
    const gets = ctx.app.routeIndex.filter((r) => r.method === 'GET' && r.url.startsWith('/api/') && !r.url.includes(':') && !SKIP.has(r.url));
    expect(gets.length).toBeGreaterThan(40);
    for (const r of gets) {
      const res = await ctx.app.inject({ url: r.url, headers: A.headers });
      const found = idsOfB(res.body);
      if (found.length) problems.push(`GET ${r.url} → ${res.statusCode} devolve dados de B (${found.slice(0, 3).join(', ')})`);
    }
    console.warn(`Casos (campo do corpo com identificador de B → status; controle com A → status):\n${summary.join('\n')}`);
    expect(problems).toEqual([]);
  }, 120_000);
});
