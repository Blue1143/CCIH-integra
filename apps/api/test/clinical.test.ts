import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { todayIn } from '@ccih/domain';
import { login, setupTestApp, teardown, type Session, type TestContext, accessBody } from './helpers';

let ctx: TestContext;
let enf: Session;
let auditor: Session;
let infecto: Session;
const sectorId = async (code: string) => (await ctx.db.selectFrom('sector').select('id').where('code', '=', code).executeTakeFirstOrThrow()).id;
const freeBed = async (code: string) =>
  (await ctx.db.selectFrom('bed').innerJoin('sector', 'sector.id', 'bed.sector_id').select('bed.id').where('sector.code', '=', code)
    .where('bed.id', 'not in', ctx.db.selectFrom('admission_movement').select('bed_id').where('end_at', 'is', null).where('bed_id', 'is not', null))
    .executeTakeFirstOrThrow()).id;
const api = (s: Session, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) => ctx.app.inject({ method, url: `/api${url}`, headers: s.headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

beforeAll(async () => {
  ctx = await setupTestApp({ FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
  [enf, auditor, infecto] = await Promise.all([login(ctx.app, 'enf.ccih'), login(ctx.app, 'auditor'), login(ctx.app, 'infecto')]);
});
afterAll(async () => teardown(ctx));

/** "Today" as the institution sees it (its time zone, not UTC: late evening in Brazil is already tomorrow in UTC). */
const institutionToday = async () => todayIn((await ctx.db.selectFrom('institution').select('timezone').executeTakeFirstOrThrow()).timezone);

describe('synthetic clinical seed', () => {
  it('populates inpatients, census and consolidated facts flagged as demo', async () => {
    const list = (await api(enf, 'GET', '/patients')).json();
    expect(list.total).toBeGreaterThan(50);
    expect(list.rows[0].origin).toBe('demo');
    expect(list.rows[0]).not.toHaveProperty('fullName');
    const census = (await api(enf, 'GET', '/census')).json();
    expect(census.ruleMissing).toBe(false);
    expect(census.rows.reduce((s: number, r: { pacientes: number }) => s + r.pacientes, 0)).toBeGreaterThan(50);
    const consolidated = await ctx.db.selectFrom('indicator_fact').select(['metric', 'data_origin']).where('metric', '=', 'pacientes_dia').execute();
    expect(consolidated.every((r) => r.data_origin === 'demo')).toBe(true);
  });

  it('denies clinical data to profiles without permission (and audits it)', async () => {
    const consulta = await login(ctx.app, 'consulta');
    expect((await api(consulta, 'GET', '/patients')).statusCode).toBe(403);
    expect((await api(consulta, 'GET', '/iras')).statusCode).toBe(403);
    const denied = await ctx.db.selectFrom('audit_log').select('entity_id').where('action', '=', 'access_denied').orderBy('id', 'desc').limit(1).executeTakeFirstOrThrow();
    expect(denied.entity_id).toBe('GET /api/iras');
  });
});

describe('patients, identification and admissions', () => {
  let patientId: string;
  let admissionId: string;

  it('creates a patient with an admission; the full name is stored encrypted', async () => {
    const res = await api(enf, 'POST', '/patients', {
      recordNumber: 'TESTE-0001', initials: '', fullName: 'Paciente Ficticio de Teste', birthDate: '1970-05-02', sex: 'F',
      admission: { admittedAt: hoursAgo(72), sectorId: await sectorId('uti-adulto'), bedId: await freeBed('uti-adulto'), diagnosis: 'Teste' },
    });
    expect(res.statusCode).toBe(201);
    patientId = res.json().id;
    const row = await ctx.db.selectFrom('patient').selectAll().where('id', '=', patientId).executeTakeFirstOrThrow();
    expect(row.initials).toBe('PFT');
    expect(row.full_name_enc).toMatch(/^v1\./);
    expect(row.full_name_enc).not.toContain('Ficticio');
    const detail = (await api(enf, 'GET', `/patients/${patientId}`)).json();
    expect(detail.hasFullName).toBe(true);
    expect(JSON.stringify(detail)).not.toContain('Ficticio');
    admissionId = detail.current.admissionId;
    const audits = await ctx.db.selectFrom('audit_log').select(['after']).where('entity', '=', 'patient').where('entity_id', '=', patientId).execute();
    expect(JSON.stringify(audits)).not.toContain('Ficticio');
    expect(JSON.stringify(audits)).not.toContain('v1.');
  });

  it('rejects duplicates and occupied beds', async () => {
    const dup = await api(enf, 'POST', '/patients', { recordNumber: 'TESTE-0001', initials: 'AB', fullName: null, birthDate: null, sex: 'M', admission: null });
    expect(dup.statusCode).toBe(409);
    const busyBed = await ctx.db.selectFrom('admission_movement').select('bed_id').where('admission_id', '=', admissionId).where('end_at', 'is', null).executeTakeFirstOrThrow();
    const res = await api(enf, 'POST', '/patients', { recordNumber: 'TESTE-0002', initials: 'CD', fullName: null, birthDate: null, sex: 'M', admission: { admittedAt: hoursAgo(1), sectorId: await sectorId('uti-adulto'), bedId: busyBed.bed_id, diagnosis: null } });
    expect(res.statusCode).toBe(409);
    expect(res.json().fields[0].path).toBe('bedId');
  });

  it('reveals the name only with the specific permission, a reason and an audit record', async () => {
    expect((await api(auditor, 'POST', `/patients/${patientId}/reveal`, { reason: 'Conferência de identificação' })).statusCode).toBe(403);
    expect((await api(enf, 'POST', `/patients/${patientId}/reveal`, { reason: 'curto' })).statusCode).toBe(400);
    const res = await api(enf, 'POST', `/patients/${patientId}/reveal`, { reason: 'Conferência de identificação para notificação' });
    expect(res.json().fullName).toBe('Paciente Ficticio de Teste');
    const log = await ctx.db.selectFrom('audit_log').select(['context']).where('action', '=', 'view_identified').where('entity_id', '=', patientId).executeTakeFirstOrThrow();
    expect(log.context).toMatchObject({ reason: 'Conferência de identificação para notificação', field: 'full_name' });
    expect(JSON.stringify(log)).not.toContain('Ficticio');
  });

  it('inserts and removes devices, transfers and discharges with consistent dates', async () => {
    const device = await api(enf, 'POST', `/admissions/${admissionId}/devices`, { type: 'CVC', site: 'Veia jugular interna direita', indication: null, insertedAt: hoursAgo(70) });
    expect(device.statusCode).toBe(201);
    expect((await api(enf, 'POST', `/admissions/${admissionId}/devices`, { type: 'VM', site: null, indication: null, insertedAt: hoursAgo(100) })).statusCode).toBe(400);
    let detail = (await api(enf, 'GET', `/patients/${patientId}`)).json();
    expect(detail.activeDevices).toEqual(['CVC']);
    const transfer = await api(enf, 'POST', `/admissions/${admissionId}/transfer`, { at: hoursAgo(2), sectorId: await sectorId('clinica-medica'), bedId: null, reason: 'Melhora clínica', rowVersion: detail.admissions[0].rowVersion });
    expect(transfer.statusCode).toBe(200);
    const stale = await api(enf, 'POST', `/admissions/${admissionId}/discharge`, { at: hoursAgo(1), outcome: 'alta', rowVersion: detail.admissions[0].rowVersion });
    expect(stale.statusCode).toBe(409);
    detail = (await api(enf, 'GET', `/patients/${patientId}`)).json();
    const discharge = await api(enf, 'POST', `/admissions/${admissionId}/discharge`, { at: hoursAgo(1), outcome: 'alta', rowVersion: detail.admissions[0].rowVersion });
    expect(discharge.json()).toMatchObject({ ok: true, devicesClosed: 1 });
    detail = (await api(enf, 'GET', `/patients/${patientId}`)).json();
    expect(detail.current).toBeNull();
    expect(detail.admissions[0].movements.map((m: { end: string | null }) => m.end === null)).toEqual([false, false]);
  });

  it('keeps CCIH notes append-only: corrections are new notes', async () => {
    const note = await api(enf, 'POST', `/patients/${patientId}/notes`, { kind: 'avaliacao', body: 'Avaliação inicial de teste.', admissionId, caseId: null });
    const noteId = note.json().id;
    const amend = await api(enf, 'POST', `/notes/${noteId}/amend`, { body: 'Avaliação inicial corrigida.', justification: 'Correção de digitação no registro' });
    expect(amend.statusCode).toBe(201);
    expect((await api(enf, 'POST', `/notes/${noteId}/amend`, { body: 'Outra', justification: 'Segunda correção do mesmo registro' })).statusCode).toBe(409);
    const notes = (await api(enf, 'GET', `/patients/${patientId}`)).json().notes;
    expect(notes.find((n: { id: string }) => n.id === noteId)).toMatchObject({ body: 'Avaliação inicial de teste.', amendedBy: amend.json().id });
    await expect(sql`UPDATE ccih_note SET body = 'x' WHERE id = ${noteId}`.execute(ctx.db)).rejects.toThrow();
  });
});

describe('IRAS surveillance workflow', () => {
  let caseId: string;
  let admissionId: string;
  let deviceId: string;

  it('registers a suspicion linked to the admission device', async () => {
    const adm = await ctx.db.selectFrom('admission').innerJoin('device_use', 'device_use.admission_id', 'admission.id').innerJoin('admission_movement as m', 'm.admission_id', 'admission.id')
      .select(['admission.id', 'device_use.id as device_id', 'm.sector_id']).where('admission.discharged_at', 'is', null).where('device_use.device_type', '=', 'CVC').where('m.end_at', 'is', null)
      .where('device_use.inserted_at', '<', new Date(Date.now() - 4 * 86_400_000)).where('device_use.removed_at', 'is', null).orderBy('device_use.inserted_at').executeTakeFirstOrThrow();
    admissionId = adm.id;
    deviceId = adm.device_id;
    const today = await institutionToday();
    const res = await api(enf, 'POST', '/iras', { admissionId, type: 'IPCS', eventDate: today, sectorId: adm.sector_id, description: 'Febre e hemocultura positiva (teste).', deviceUseId: deviceId, surgeryId: null, cultureIds: [], justification: 'Busca ativa identificou critérios iniciais' });
    expect(res.statusCode).toBe(201);
    caseId = res.json().id;
    const detail = (await api(enf, 'GET', `/iras/${caseId}`)).json();
    expect(detail.status).toBe('suspeita');
    expect(detail.history).toHaveLength(1);
    expect(detail.context.devices.find((d: { id: string }) => d.id === deviceId)).toMatchObject({ association: 'elegivel', relevant: true });
  });

  it('rejects links to another admission', async () => {
    const other = await ctx.db.selectFrom('device_use').select('id').where('admission_id', '!=', admissionId).executeTakeFirstOrThrow();
    const detail = (await api(enf, 'GET', `/iras/${caseId}`)).json();
    const res = await api(enf, 'PUT', `/iras/${caseId}`, { type: 'IPCS', eventDate: detail.eventDate, sectorId: detail.sectorId, description: null, deviceUseId: other.id, surgeryId: null, cultureIds: [], rowVersion: detail.rowVersion, justification: 'Tentativa de vínculo indevido' });
    expect(res.statusCode).toBe(400);
  });

  it('enforces the transitions, required decision data and permissions', async () => {
    let detail = (await api(enf, 'GET', `/iras/${caseId}`)).json();
    const skip = await api(enf, 'POST', `/iras/${caseId}/status`, { to: 'confirmada', justification: 'Pular a investigação', criterionReferenceId: null, deviceAssociated: null, rowVersion: detail.rowVersion });
    expect(skip.statusCode).toBe(400);
    expect((await api(enf, 'POST', `/iras/${caseId}/status`, { to: 'em_investigacao', justification: 'Revisão de prontuário iniciada', criterionReferenceId: null, deviceAssociated: null, rowVersion: detail.rowVersion })).statusCode).toBe(200);
    detail = (await api(enf, 'GET', `/iras/${caseId}`)).json();
    expect((await api(auditor, 'POST', `/iras/${caseId}/status`, { to: 'descartada', justification: 'Auditor não decide casos', criterionReferenceId: null, deviceAssociated: null, rowVersion: detail.rowVersion })).statusCode).toBe(403);
    const missing = await api(infecto, 'POST', `/iras/${caseId}/status`, { to: 'confirmada', justification: 'Critérios atendidos após revisão', criterionReferenceId: null, deviceAssociated: null, rowVersion: detail.rowVersion });
    expect(missing.json().fields.map((f: { path: string }) => f.path)).toEqual(['criterionReferenceId', 'deviceAssociated']);
    const ref = await ctx.db.selectFrom('clinical_reference').select('id').where('code', '=', 'ref-anvisa-criterios-iras').executeTakeFirstOrThrow();
    const ok = await api(infecto, 'POST', `/iras/${caseId}/status`, { to: 'confirmada', justification: 'Critérios atendidos após revisão', criterionReferenceId: ref.id, deviceAssociated: true, rowVersion: detail.rowVersion });
    expect(ok.json()).toMatchObject({ ok: true, criterionValidated: false });
    detail = (await api(enf, 'GET', `/iras/${caseId}`)).json();
    expect(detail.history.map((h: { to: string }) => h.to)).toEqual(['suspeita', 'em_investigacao', 'confirmada']);
    expect(detail.criterion).toMatchObject({ code: 'ref-anvisa-criterios-iras', validated: false });
    const edit = await api(enf, 'PUT', `/iras/${caseId}`, { type: 'PAV', eventDate: detail.eventDate, sectorId: detail.sectorId, description: null, deviceUseId: deviceId, surgeryId: null, cultureIds: [], rowVersion: detail.rowVersion, justification: 'Editar caso concluído' });
    expect(edit.statusCode).toBe(409);
    await expect(sql`DELETE FROM iras_case_status WHERE case_id = ${caseId}`.execute(ctx.db)).rejects.toThrow();
  });

  it('counts the confirmed case when the month is consolidated (audited)', async () => {
    const month = `${(await institutionToday()).slice(0, 7)}-01`;
    const res = await api(enf, 'POST', '/facts/consolidate', { months: [month] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ partialMonth: true, origin: 'demo' });
    const total = await ctx.db.selectFrom('indicator_fact').select((eb) => eb.fn.sum<string>('value').as('n')).where('period', '=', month).where('metric', '=', 'iras_ipcs').executeTakeFirstOrThrow();
    expect(Number(total.n)).toBeGreaterThanOrEqual(1);
    expect(await ctx.db.selectFrom('audit_log').select('id').where('action', '=', 'consolidate').executeTakeFirst()).toBeDefined();
    expect((await api(auditor, 'POST', '/facts/consolidate', { months: [month] })).statusCode).toBe(403);
  });
});

describe('sector scope on clinical data', () => {
  it('limits patients and cases to the user sectors and hides the rest as not found', async () => {
    const admin = await login(ctx.app, 'admin');
    const user = await ctx.db.selectFrom('app_user').select(['id', 'row_version']).where('login', '=', 'consulta').executeTakeFirstOrThrow();
    const coronary = await sectorId('uti-coronariana');
    const patch = await api(admin, 'PUT', `/users/${user.id}`, accessBody({ displayName: 'Consulta (escopo)', functionRole: 'enf_ccih', scopeAll: false, sectorIds: [coronary], rowVersion: user.row_version, justification: 'Teste de escopo por setor' }));
    expect(patch.statusCode).toBe(200);
    const scoped = await login(ctx.app, 'consulta');
    const list = (await api(scoped, 'GET', '/patients?pageSize=100')).json();
    expect(list.rows.length).toBeGreaterThan(0);
    expect(list.rows.every((p: { current: { sectorId: string } }) => p.current.sectorId === coronary)).toBe(true);
    const outside = await ctx.db.selectFrom('admission_movement as m').innerJoin('admission as a', 'a.id', 'm.admission_id').select('a.patient_id').where('m.sector_id', '=', await sectorId('uti-adulto'))
      .where('a.patient_id', 'not in', ctx.db.selectFrom('admission').select('patient_id').where('id', 'in', ctx.db.selectFrom('admission_movement').select('admission_id').where('sector_id', '=', coronary))).executeTakeFirstOrThrow();
    expect((await api(scoped, 'GET', `/patients/${outside.patient_id}`)).statusCode).toBe(404);
    const cases = (await api(scoped, 'GET', '/iras?pageSize=100')).json();
    expect(cases.rows.every((c: { sectorId: string }) => c.sectorId === coronary)).toBe(true);
    const census = (await api(scoped, 'GET', '/census')).json();
    expect(census.rows.map((r: { sectorId: string }) => r.sectorId)).toEqual([coronary]);
    const otherAdmission = await ctx.db.selectFrom('admission').select('id').where('patient_id', '=', outside.patient_id).executeTakeFirstOrThrow();
    expect((await api(scoped, 'POST', `/admissions/${otherAdmission.id}/devices`, { type: 'CVC', site: null, indication: null, insertedAt: hoursAgo(1) })).statusCode).toBe(404);
  });
});

describe('surgery and microbiology', () => {
  it('records a surgery and evaluates prophylaxis with the configured window', async () => {
    const adm = await ctx.db.selectFrom('admission').innerJoin('admission_movement as m', 'm.admission_id', 'admission.id').select(['admission.id', 'admission.admitted_at'])
      .where('admission.discharged_at', 'is', null).where('m.end_at', 'is', null).where('m.sector_id', '=', await sectorId('clinica-cirurgica')).executeTakeFirstOrThrow();
    const [proc, surgeon] = await Promise.all([
      ctx.db.selectFrom('procedure_catalog').select('id').where('code', '=', 'herniorrafia-inguinal').executeTakeFirstOrThrow(),
      ctx.db.selectFrom('professional').select('id').where('name', 'like', 'Cirurgião%').executeTakeFirstOrThrow(),
    ]);
    const start = new Date(Math.max(adm.admitted_at.getTime() + 60_000, Date.now() - 3_600_000));
    const base = {
      admissionId: adm.id, procedureId: proc.id, surgeonId: surgeon.id, sectorId: await sectorId('clinica-cirurgica'), room: 'Sala 1', startedAt: start.toISOString(), endedAt: new Date(start.getTime() + 50 * 60_000).toISOString(),
      woundClass: 'limpa', asa: 2, implant: true, urgency: false, prophylaxisIndicated: true, prophylaxisDrug: 'Cefazolina', prophylaxisDoseAt: new Date(start.getTime() - 90 * 60_000).toISOString(),
      prophylaxisDurationH: 0, redose: false, notes: null,
    };
    expect((await api(enf, 'POST', '/surgeries', base)).json().fields[0].path).toBe('sectorId');
    const res = await api(enf, 'POST', '/surgeries', { ...base, sectorId: await sectorId('centro-cirurgico') });
    expect(res.statusCode).toBe(201);
    const detail = (await api(enf, 'GET', `/surgeries/${res.json().id}`)).json();
    expect(detail.prophylaxis).toMatchObject({ result: 'nao_conforme', appliedWindowMin: 60 });
    expect(detail.risk).toMatchObject({ score: 0, complete: true });
    expect(detail.surveillance.days).toBe(90);
    expect(detail.prophylaxisDrug).toBe('cefazolina');
  });

  it('versions culture results: corrections need a justification and never overwrite', async () => {
    const adm = await ctx.db.selectFrom('admission').innerJoin('admission_movement as m', 'm.admission_id', 'admission.id').select(['admission.id', 'm.sector_id'])
      .where('admission.discharged_at', 'is', null).where('m.end_at', 'is', null).where('m.sector_id', '=', await sectorId('uti-adulto')).executeTakeFirstOrThrow();
    const created = await api(infecto, 'POST', '/cultures', { admissionId: adm.id, sectorId: adm.sector_id, material: 'sangue', collectedAt: hoursAgo(30) });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await api(enf, 'POST', '/cultures', { admissionId: adm.id, sectorId: adm.sector_id, material: 'sangue', collectedAt: hoursAgo(30) })).statusCode).toBe(403);
    const first = await api(infecto, 'POST', `/cultures/${id}/results`, { outcome: 'negativa', reportedAt: hoursAgo(2), breakpointVersion: null, notes: null, isolates: [], justification: null });
    expect(first.json().version).toBe(1);
    const isolate = { organism: 'Klebsiella pneumoniae', quantity: null, resistanceProfile: 'MDR', mechanism: 'KPC', susceptibility: [{ antimicrobial: 'Meropeném', mic: null, interpretation: 'R' }] };
    expect((await api(infecto, 'POST', `/cultures/${id}/results`, { outcome: 'positiva', reportedAt: hoursAgo(1), breakpointVersion: 'BrCAST 2026 (teste)', notes: null, isolates: [isolate], justification: null })).statusCode).toBe(400);
    const second = await api(infecto, 'POST', `/cultures/${id}/results`, { outcome: 'positiva', reportedAt: hoursAgo(1), breakpointVersion: 'BrCAST 2026 (teste)', notes: null, isolates: [isolate], justification: 'Laboratório reemitiu o laudo corrigido' });
    expect(second.json().version).toBe(2);
    const detail = (await api(enf, 'GET', `/cultures/${id}`)).json();
    expect(detail).toMatchObject({ outcome: 'positiva', resistance: ['MDR'], resultVersion: 2 });
    expect(detail.results.map((r: { version: number; outcome: string }) => [r.version, r.outcome])).toEqual([[2, 'positiva'], [1, 'negativa']]);
    const resistant = (await api(enf, 'GET', '/cultures?resistant=true&pageSize=100')).json();
    expect(resistant.rows.some((c: { id: string }) => c.id === id)).toBe(true);
  });
});

describe('organization', () => {
  it('lets the administrator add beds and refuses to deactivate an occupied one', async () => {
    const admin = await login(ctx.app, 'admin');
    const sector = await sectorId('uti-coronariana');
    expect((await api(enf, 'POST', `/org/sectors/${sector}/beds`, { codes: ['99'], justification: 'Ampliação de leitos da unidade' })).statusCode).toBe(403);
    expect((await api(admin, 'POST', `/org/sectors/${sector}/beds`, { codes: ['99'], justification: 'Ampliação de leitos da unidade' })).statusCode).toBe(201);
    const occupied = await ctx.db.selectFrom('admission_movement').select('bed_id').where('end_at', 'is', null).where('bed_id', 'is not', null).executeTakeFirstOrThrow();
    expect((await api(admin, 'PUT', `/org/beds/${occupied.bed_id}`, { active: false, justification: 'Manutenção do leito programada' })).statusCode).toBe(409);
    const org = (await api(admin, 'GET', '/org')).json();
    expect(org.sectors.find((s: { id: string }) => s.id === sector).beds.some((b: { code: string }) => b.code === '99')).toBe(true);
  });
});

describe('missing rules', () => {
  it('does not compute denominators without a census hour and accepts its first configuration', async () => {
    await ctx.db.deleteFrom('rule_parameter').where('key', '=', 'admissions.censusHour').execute();
    expect((await api(enf, 'GET', '/census')).json()).toMatchObject({ ruleMissing: true, hour: null });
    const month = `${new Date().toISOString().slice(0, 7)}-01`;
    const r = (await api(enf, 'POST', '/facts/consolidate', { months: [month] })).json();
    expect(r.metrics).not.toContain('pacientes_dia');
    expect(r.skipped[0]).toMatch(/censo/);
    const admin = await login(ctx.app, 'admin');
    expect((await api(admin, 'PUT', '/config/rules/admissions.censusHour', { value: 7, referenceId: null, rowVersion: 1, justification: 'Configuração inicial do censo' })).statusCode).toBe(409);
    expect((await api(admin, 'PUT', '/config/rules/admissions.censusHour', { value: 7, referenceId: null, rowVersion: null, justification: 'Configuração inicial do censo' })).statusCode).toBe(200);
    expect((await api(enf, 'GET', '/census')).json()).toMatchObject({ ruleMissing: false, hour: 7 });
  });
});
