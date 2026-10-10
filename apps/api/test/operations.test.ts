import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { ORIGIN, accessBody, login, setupTestApp, teardown, type Session, type TestContext } from './helpers';

let ctx: TestContext;
let enf: Session;
let auditor: Session;
let admin: Session;
let quality: Session;
const api = (s: Session, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => ctx.app.inject({ method, url: `/api${url}`, headers: s.headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const sectorId = async (code: string) => (await ctx.db.selectFrom('sector').select('id').where('code', '=', code).executeTakeFirstOrThrow()).id;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const J = 'Registro de teste da CCIH';

beforeAll(async () => {
  ctx = await setupTestApp();
  [enf, auditor, admin, quality] = await Promise.all([login(ctx.app, 'enf.ccih'), login(ctx.app, 'auditor'), login(ctx.app, 'admin'), login(ctx.app, 'enf.qualidade')]);
});
afterAll(async () => teardown(ctx));

describe('bundles and hand hygiene', () => {
  it('records an audit only with every item answered and evaluates it by the template method', async () => {
    const { templates } = (await api(enf, 'GET', '/bundles/templates')).json();
    const cvc = templates.find((t: { code: string }) => t.code === 'bundle-cvc');
    const uti = await sectorId('uti-adulto');
    const partial = await api(enf, 'POST', '/bundles/audits', { templateId: cvc.id, sectorId: uti, admissionId: null, auditedAt: hoursAgo(1), notes: null, answers: [{ itemId: cvc.items[0].id, answer: 'conforme' }] });
    expect(partial.statusCode).toBe(400);
    const answers = cvc.items.map((i: { id: string }, n: number) => ({ itemId: i.id, answer: n === 1 ? 'nao_conforme' : 'conforme' }));
    const res = await api(enf, 'POST', '/bundles/audits', { templateId: cvc.id, sectorId: uti, admissionId: null, auditedAt: hoursAgo(1), notes: null, answers });
    expect(res.json()).toMatchObject({ result: 'nao_conforme', nonCompliant: 1 });
    const before = (await api(enf, 'GET', '/bundles/summary')).json();
    const row = (s: { rows: Array<{ templateId: string; sectorId: string; audits: number }> }) => s.rows.find((r) => r.templateId === cvc.id && r.sectorId === uti)!;
    expect((await api(enf, 'POST', `/bundles/audits/${res.json().id}/void`, { reason: 'Auditoria registrada no setor errado' })).statusCode).toBe(200);
    const after = (await api(enf, 'GET', '/bundles/summary')).json();
    expect(row(after).audits).toBe(row(before).audits - 1);
    expect(before.pareto.length).toBeGreaterThan(0);
  });

  it('keeps past answers when an item text changes and allows one active template per indicator', async () => {
    const { templates } = (await api(admin, 'GET', '/bundles/templates')).json();
    const svd = templates.find((t: { code: string }) => t.code === 'bundle-svd');
    const items = svd.items.map((i: { id: string; label: string }, n: number) => ({ id: i.id, label: n === 0 ? 'Fixação adequada conforme protocolo revisado' : i.label }));
    const body = { code: 'bundle-svd', name: svd.name, metric: 'svd', method: 'tudo_ou_nada', referenceId: null, active: true, items, rowVersion: svd.rowVersion, justification: J };
    expect((await api(enf, 'PUT', '/bundles/templates', body)).statusCode).toBe(403);
    expect((await api(admin, 'PUT', '/bundles/templates', body)).statusCode).toBe(200);
    const old = await ctx.db.selectFrom('bundle_audit_answer').select('item_label').where('item_id', '=', svd.items[0].id).limit(1).executeTakeFirstOrThrow();
    expect(old.item_label).toBe('Fixação adequada');
    const dup = await api(admin, 'PUT', '/bundles/templates', { code: 'bundle-svd-2', name: 'Outro', metric: 'svd', method: 'por_item', referenceId: null, active: true, items: [{ id: null, label: 'Item' }], rowVersion: null, justification: J });
    expect(dup.json().fields[0].path).toBe('metric');
    expect((await api(auditor, 'PUT', '/bundles/templates', body)).statusCode).toBe(403);
  });

  it('validates hand hygiene observations', async () => {
    const uti = await sectorId('uti-adulto');
    expect((await api(enf, 'POST', '/hand-hygiene', { sectorId: uti, observedAt: hoursAgo(2), category: 'enfermagem', opportunities: 5, actions: 6 })).statusCode).toBe(400);
    expect((await api(enf, 'POST', '/hand-hygiene', { sectorId: uti, observedAt: hoursAgo(2), category: 'enfermagem', opportunities: 10, actions: 8 })).statusCode).toBe(201);
    const consulta = await login(ctx.app, 'consulta');
    expect((await api(consulta, 'GET', '/hand-hygiene')).statusCode).toBe(403);
  });
});

describe('quality audits, non-conformities and 5W2H', () => {
  it('follows the workflow with its requirements and an append-only history', async () => {
    const sector = await sectorId('clinica-medica');
    const created = await api(quality, 'POST', '/quality/audits', { title: 'Auditoria de teste', kind: 'processo', sectorId: sector, scope: null, plannedFor: today(), justification: J });
    const id = created.json().id;
    let a = (await api(quality, 'GET', `/quality/audits/${id}`)).json();
    expect((await api(quality, 'POST', `/quality/audits/${id}/status`, { to: 'em_andamento', justification: J, rowVersion: a.rowVersion })).statusCode).toBe(200);
    a = (await api(quality, 'GET', `/quality/audits/${id}`)).json();
    expect((await api(quality, 'POST', `/quality/audits/${id}/status`, { to: 'concluida', justification: J, rowVersion: a.rowVersion })).json().fields[0].path).toBe('findings');
    await api(quality, 'PUT', `/quality/audits/${id}`, { title: a.title, scope: null, plannedFor: a.plannedFor, findings: 'Achado de teste', rowVersion: a.rowVersion, justification: J });
    a = (await api(quality, 'GET', `/quality/audits/${id}`)).json();
    expect((await api(quality, 'POST', `/quality/audits/${id}/status`, { to: 'concluida', justification: J, rowVersion: a.rowVersion })).statusCode).toBe(200);

    const nc = (await api(quality, 'POST', '/quality/nonconformities', { auditId: id, sectorId: sector, origin: 'auditoria', severity: 'media', description: 'NC de teste', detectedOn: today(), justification: J })).json().id;
    let n = (await api(quality, 'GET', `/quality/nonconformities/${nc}`)).json();
    expect((await api(quality, 'POST', `/quality/nonconformities/${nc}/status`, { to: 'em_tratamento', effectiveness: null, justification: J, rowVersion: n.rowVersion })).json().fields[0].path).toBe('actions');
    const action = (await api(quality, 'POST', `/quality/nonconformities/${nc}/actions`, { what: 'Treinar equipe', why: 'NC de teste', where: 'Clínica Médica', who: 'Coordenação', dueOn: today(), how: 'Treinamento em serviço', howMuch: null })).json().id;
    expect((await api(quality, 'POST', `/quality/nonconformities/${nc}/status`, { to: 'em_tratamento', effectiveness: null, justification: J, rowVersion: n.rowVersion })).statusCode).toBe(200);
    n = (await api(quality, 'GET', `/quality/nonconformities/${nc}`)).json();
    expect((await api(quality, 'POST', `/quality/nonconformities/${nc}/status`, { to: 'aguardando_eficacia', effectiveness: null, justification: J, rowVersion: n.rowVersion })).statusCode).toBe(400);
    expect((await api(quality, 'POST', `/quality/actions/${action}/status`, { status: 'concluida', completedOn: today(), rowVersion: 1, justification: J })).statusCode).toBe(200);
    expect((await api(quality, 'POST', `/quality/nonconformities/${nc}/status`, { to: 'aguardando_eficacia', effectiveness: null, justification: J, rowVersion: n.rowVersion })).statusCode).toBe(200);
    n = (await api(quality, 'GET', `/quality/nonconformities/${nc}`)).json();
    expect((await api(quality, 'POST', `/quality/nonconformities/${nc}/status`, { to: 'encerrada', effectiveness: null, justification: J, rowVersion: n.rowVersion })).json().fields[0].path).toBe('effectiveness');
    expect((await api(quality, 'POST', `/quality/nonconformities/${nc}/status`, { to: 'encerrada', effectiveness: 'Reauditoria conforme', justification: J, rowVersion: n.rowVersion })).statusCode).toBe(200);
    n = (await api(quality, 'GET', `/quality/nonconformities/${nc}`)).json();
    expect(n.history.map((h: { to: string }) => h.to)).toEqual(['aberta', 'em_tratamento', 'aguardando_eficacia', 'encerrada']);
    await expect(sql`DELETE FROM nonconformity_status WHERE nonconformity_id = ${nc}`.execute(ctx.db)).rejects.toThrow();
    expect((await api(auditor, 'POST', `/quality/nonconformities/${nc}/actions`, { what: 'x', why: 'x', where: 'x', who: 'x', dueOn: today(), how: 'x', howMuch: null })).statusCode).toBe(403);
  });
});

describe('alert center', () => {
  it('generates deduplicated alerts, requires a resolution to close and suppresses reopening', async () => {
    const first = (await api(enf, 'GET', '/alerts?pageSize=100')).json();
    expect(first.total).toBeGreaterThan(0);
    const kinds = new Set(first.rows.map((a: { kind: string }) => a.kind));
    expect(kinds.has('plano_acao_atrasado')).toBe(true);
    expect(kinds.has('insumo_critico')).toBe(true);
    // A second refresh does not duplicate.
    expect((await api(enf, 'POST', '/alerts/refresh')).json()).toMatchObject({ created: 0 });
    const keys = await ctx.db.selectFrom('alert').select('dedup_key').where('status', '<>', 'encerrado').execute();
    expect(new Set(keys.map((k) => k.dedup_key)).size).toBe(keys.length);

    const target = first.rows.find((a: { kind: string }) => a.kind === 'insumo_critico');
    expect((await api(auditor, 'POST', `/alerts/${target.id}/close`, { resolution: 'Compra emergencial solicitada', rowVersion: target.rowVersion })).statusCode).toBe(403);
    const assumed = await api(enf, 'POST', `/alerts/${target.id}/assume`, { rowVersion: target.rowVersion });
    expect(assumed.statusCode).toBe(200);
    expect((await api(enf, 'POST', `/alerts/${target.id}/close`, { resolution: 'curto', rowVersion: assumed.json().rowVersion })).statusCode).toBe(400);
    expect((await api(enf, 'POST', `/alerts/${target.id}/close`, { resolution: 'Compra emergencial solicitada ao almoxarifado', rowVersion: assumed.json().rowVersion })).statusCode).toBe(200);
    await api(enf, 'POST', '/alerts/refresh');
    const reopened = await ctx.db.selectFrom('alert').select('id').where('dedup_key', '=', (await ctx.db.selectFrom('alert').select('dedup_key').where('id', '=', target.id).executeTakeFirstOrThrow()).dedup_key).where('status', '<>', 'encerrado').executeTakeFirst();
    expect(reopened).toBeUndefined();
  });

  it('closes alerts automatically when the source condition is resolved', async () => {
    const overdue = await ctx.db.selectFrom('alert').select(['entity_id']).where('kind', '=', 'plano_acao_atrasado').where('status', '<>', 'encerrado').executeTakeFirstOrThrow();
    const action = await ctx.db.selectFrom('action_plan').select('row_version').where('id', '=', overdue.entity_id!).executeTakeFirstOrThrow();
    expect((await api(quality, 'POST', `/quality/actions/${overdue.entity_id}/status`, { status: 'concluida', completedOn: today(), rowVersion: action.row_version, justification: J })).statusCode).toBe(200);
    await api(enf, 'POST', '/alerts/refresh');
    const after = await ctx.db.selectFrom('alert').select(['status', 'closed_by_name']).where('entity_id', '=', overdue.entity_id).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    expect(after).toMatchObject({ status: 'encerrado', closed_by_name: 'Sistema' });
    // The closed history lists the most recently closed first.
    const closed = (await api(enf, 'GET', '/alerts?status=encerrado&pageSize=100')).json().rows as { entityId: string; closedAt: string }[];
    expect(closed[0]?.entityId).toBe(overdue.entity_id);
    expect(closed.map((a) => a.closedAt)).toEqual([...closed.map((a) => a.closedAt)].sort().reverse());
  });

  it('shows each kind only to profiles of its module', async () => {
    const cme = await login(ctx.app, 'cme');
    const rows = (await api(cme, 'GET', '/alerts?pageSize=100')).json().rows as { kind: string }[];
    // The CME profile sees only the CME alerts (no patient, IRAS, training or supply alerts).
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((a) => a.kind.startsWith('cme_'))).toBe(true);
  });
});

describe('training and supplies', () => {
  it('raises coverage when a session with attendance is recorded', async () => {
    const { trainings } = (await api(enf, 'GET', '/trainings')).json();
    const hm = trainings.find((t: { title: string }) => t.title.startsWith('Higiene das mãos'));
    const coverage = (await api(enf, 'GET', '/trainings/coverage')).json();
    const missing = coverage.rows.filter((r: { trainingId: string; state: string }) => r.trainingId === hm.id && (r.state === 'pendente' || r.state === 'vencido')).slice(0, 3);
    expect(missing.length).toBeGreaterThan(0);
    const body = { heldOn: today(), instructor: 'Equipe CCIH', hours: 2, sectorId: null, notes: null, attendees: missing.map((m: { professionalId: string }) => ({ professionalId: m.professionalId, present: true, score: 90 })) };
    expect((await api(enf, 'POST', `/trainings/${hm.id}/sessions`, { ...body, heldOn: '2999-01-01' })).statusCode).toBe(400);
    expect((await api(enf, 'POST', `/trainings/${hm.id}/sessions`, body)).statusCode).toBe(201);
    const updated = (await api(enf, 'GET', '/trainings')).json().trainings.find((t: { id: string }) => t.id === hm.id);
    expect(updated.covered).toBe(hm.covered + missing.length);
  });

  it('keeps an append-only ledger that never goes below zero', async () => {
    const { supplies } = (await api(enf, 'GET', '/supplies')).json();
    const n95 = supplies.find((s: { code: string }) => s.code === 'mascara-n95');
    expect(n95.evaluation.status).toBe('crit');
    const uti = await sectorId('uti-adulto');
    const lot = `TESTE-${Date.now()}`;
    expect((await api(enf, 'POST', `/supplies/${n95.id}/movements`, { kind: 'consumo', lot, expiresOn: null, quantity: 1, sectorId: uti, occurredAt: hoursAgo(1), reason: null })).statusCode).toBe(400);
    expect((await api(enf, 'POST', `/supplies/${n95.id}/movements`, { kind: 'entrada', lot, expiresOn: '2027-12-31', quantity: 500, sectorId: null, occurredAt: hoursAgo(2), reason: null })).statusCode).toBe(201);
    expect((await api(enf, 'POST', `/supplies/${n95.id}/movements`, { kind: 'consumo', lot, expiresOn: null, quantity: 10, sectorId: null, occurredAt: hoursAgo(1), reason: null })).json().fields[0].path).toBe('sectorId');
    expect((await api(enf, 'POST', `/supplies/${n95.id}/movements`, { kind: 'consumo', lot, expiresOn: null, quantity: 600, sectorId: uti, occurredAt: hoursAgo(1), reason: null })).json().fields[0].path).toBe('quantity');
    expect((await api(enf, 'POST', `/supplies/${n95.id}/movements`, { kind: 'descarte', lot, expiresOn: null, quantity: 5, sectorId: null, occurredAt: hoursAgo(1), reason: null })).json().fields[0].path).toBe('reason');
    expect((await api(enf, 'POST', `/supplies/${n95.id}/movements`, { kind: 'consumo', lot, expiresOn: null, quantity: 20, sectorId: uti, occurredAt: hoursAgo(1), reason: null })).statusCode).toBe(201);
    const after = (await api(enf, 'GET', '/supplies')).json().supplies.find((s: { id: string }) => s.id === n95.id);
    expect(after.quantity).toBeCloseTo(n95.quantity + 480, 1);
    await expect(sql`UPDATE supply_movement SET delta = 1`.execute(ctx.db)).rejects.toThrow();
  });
});

describe('post-discharge SSI surveillance', () => {
  it('records contacts and opens an SSI case from a suspicion', async () => {
    const list = (await api(enf, 'GET', '/surgeries/surveillance')).json();
    expect(list.ruleMissing).toBe(false);
    const row = list.rows.find((r: { dischargedAt: string | null }) => r.dischargedAt);
    const res = await api(enf, 'POST', `/surgeries/${row.surgeryId}/followups`, { contactedOn: today(), method: 'telefone', outcome: 'suspeita', notes: 'Hiperemia e secreção na ferida', openCase: true });
    expect(res.statusCode).toBe(201);
    const c = await ctx.db.selectFrom('iras_case').select(['iras_type', 'status', 'surgery_id']).where('id', '=', res.json().caseId).executeTakeFirstOrThrow();
    expect(c).toMatchObject({ iras_type: 'ISC', status: 'suspeita', surgery_id: row.surgeryId });
    const detail = (await api(enf, 'GET', `/surgeries/${row.surgeryId}`)).json();
    expect(detail.followups[0]).toMatchObject({ outcome: 'suspeita', caseId: res.json().caseId });
    const infecto = await login(ctx.app, 'infecto');
    expect((await api(infecto, 'POST', `/surgeries/${row.surgeryId}/followups`, { contactedOn: today(), method: 'telefone', outcome: 'sem_sinais', notes: null, openCase: false })).statusCode).toBe(403);
  });
});

describe('password lifecycle', () => {
  it('creates users with a temporary password that must be replaced before any access', async () => {
    const coronary = await sectorId('uti-coronariana');
    const created = await api(admin, 'POST', '/users', accessBody({ login: 'novo.usuario', displayName: 'Novo Usuário (teste)', functionRole: 'enf_ccih', scopeAll: false, sectorIds: [coronary], justification: J }));
    expect(created.statusCode).toBe(201);
    const temp = created.json().temporaryPassword as string;
    const s = await login(ctx.app, 'novo.usuario', temp);
    expect((await ctx.app.inject({ url: '/api/auth/me', headers: s.headers })).json().mustChangePassword).toBe(true);
    const blocked = await ctx.app.inject({ url: '/api/patients', headers: s.headers });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe('troca_de_senha');
    const change = (body: object) => ctx.app.inject({ method: 'POST', url: '/api/auth/password', headers: s.headers, payload: body });
    expect((await change({ currentPassword: 'errada', newPassword: 'Nova-Senha-Forte-2026' })).statusCode).toBe(400);
    expect((await change({ currentPassword: temp, newPassword: 'fraca' })).json().fields[0].path).toBe('newPassword');
    expect((await change({ currentPassword: temp, newPassword: 'novo.usuario-Senha-1!' })).json().message).toMatch(/nome de usuário/);
    expect((await change({ currentPassword: temp, newPassword: 'Nova-Senha-Forte-2026' })).statusCode).toBe(200);
    expect((await ctx.app.inject({ url: '/api/patients', headers: s.headers })).statusCode).toBe(200);
    const logs = JSON.stringify(await ctx.db.selectFrom('audit_log').select(['before', 'after', 'context']).execute());
    expect(logs).not.toContain(temp);
    expect(logs).not.toContain('Nova-Senha-Forte-2026');
  });

  it('lets the administrator reset a password, ending the user sessions', async () => {
    const s = await login(ctx.app, 'novo.usuario', 'Nova-Senha-Forte-2026');
    const user = await ctx.db.selectFrom('app_user').select('id').where('login', '=', 'novo.usuario').executeTakeFirstOrThrow();
    const reset = await api(admin, 'POST', `/users/${user.id}/reset-password`, { justification: 'Usuário esqueceu a senha' });
    expect(reset.json().temporaryPassword).toMatch(/^Tmp-/);
    expect((await ctx.app.inject({ url: '/api/patients', headers: s.headers })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { login: 'novo.usuario', password: 'Nova-Senha-Forte-2026' } })).statusCode).toBe(401);
  });
});

describe('operational consolidation', () => {
  it('replaces bundle, hand hygiene, alcohol and training facts from the records', async () => {
    const month = `${today().slice(0, 7)}-01`;
    const r = (await api(enf, 'POST', '/facts/consolidate', { months: [month] })).json();
    expect(r.metrics).toEqual(expect.arrayContaining(['bundle_cvc_auditorias', 'hm_oportunidades', 'alcool_ml', 'treinamento_publico']));
    const facts = await ctx.db.selectFrom('indicator_fact').select(['metric']).where('period', '=', month).where('metric', 'in', ['hm_oportunidades', 'treinamento_concluidos']).execute();
    expect(new Set(facts.map((f) => f.metric))).toEqual(new Set(['hm_oportunidades', 'treinamento_concluidos']));
  });
});

describe('alert generation under concurrency', () => {
  it('lets a list requested together with the counter see the generated alerts', async () => {
    await ctx.db.updateTable('alert').set({ status: 'encerrado', closed_at: new Date(), closed_by_name: 'Teste', resolution: 'Limpeza para o teste de concorrência', closed_reason: 'manual' }).where('status', '<>', 'encerrado').execute();
    await ctx.db.updateTable('alert').set({ closed_at: new Date(Date.now() - 400 * 86_400_000) }).execute().catch(() => undefined);
    const { resetAlertThrottle } = await import('../src/services/alerts');
    resetAlertThrottle(ctx.institutionId);
    const [summary, list] = await Promise.all([api(enf, 'GET', '/alerts/summary'), api(enf, 'GET', '/alerts?pageSize=100')]);
    expect(summary.json().open).toBeGreaterThan(0);
    expect(list.json().total).toBe(summary.json().open);
  });
});

describe('alert lifecycle (v2)', () => {
  it('acknowledges, assumes, comments, resolves and closes, keeping the history; viewing changes nothing', async () => {
    const { resetAlertThrottle } = await import('../src/services/alerts');
    resetAlertThrottle(ctx.institutionId);
    const list = (await api(enf, 'GET', '/alerts?status=aberto&pageSize=100')).json().rows as Array<{ id: string; rowVersion: number; blocking: boolean; category: string; unitId: string | null; sectorId: string | null }>;
    const a = list.find((x) => !x.blocking && x.sectorId)!;
    expect(a).toBeTruthy();
    expect(a.unitId).toBeTruthy();
    expect((await api(enf, 'GET', `/alerts?unitId=${a.unitId}&pageSize=100`)).json().rows.some((x: { id: string }) => x.id === a.id)).toBe(true);
    expect((await api(enf, 'GET', `/alerts?sectorId=${a.sectorId}&category=${a.category}&pageSize=100`)).json().rows.some((x: { id: string }) => x.id === a.id)).toBe(true);
    expect((await api(enf, 'GET', '/alerts?from=2000-01-01&to=2000-01-02')).json().total).toBe(0);

    const viewed = (await api(enf, 'GET', `/alerts/${a.id}`)).json();
    expect(viewed.status).toBe('aberto');
    expect(viewed.rowVersion).toBe(a.rowVersion);
    await api(enf, 'GET', `/alerts/${a.id}`);

    let v = a.rowVersion;
    const step = async (path: string, body: object = {}) => {
      const res = await api(enf, 'POST', `/alerts/${a.id}/${path}`, { ...body, rowVersion: v });
      expect(res.statusCode, res.body).toBe(200);
      v = res.json().rowVersion ?? v;
    };
    await step('acknowledge');
    expect((await api(enf, 'POST', `/alerts/${a.id}/acknowledge`, { rowVersion: v })).statusCode).toBe(409);
    await step('assume');
    expect((await api(enf, 'POST', `/alerts/${a.id}/comments`, { note: 'Contato com o setor feito por telefone' })).statusCode).toBe(201);
    expect((await api(enf, 'POST', `/alerts/${a.id}/resolve`, { note: 'curto', rowVersion: v })).statusCode).toBe(400);
    await step('resolve', { note: 'Registro corrigido no prontuário do setor' });
    expect((await api(enf, 'POST', `/alerts/${a.id}/exception`, { note: 'Não se aplica a este alerta', rowVersion: v })).statusCode).toBe(409);
    expect((await api(enf, 'POST', `/alerts/${a.id}/close`, { resolution: 'Conferido com a enfermagem do setor', rowVersion: v })).statusCode).toBe(200);

    const detail = (await api(enf, 'GET', `/alerts/${a.id}`)).json();
    expect(detail).toMatchObject({ status: 'encerrado', closedReason: 'manual', acknowledgedName: expect.any(String), resolvedNote: 'Registro corrigido no prontuário do setor' });
    expect(detail.actions.map((x: { action: string }) => x.action)).toEqual(['criado', 'visualizado', 'reconhecido', 'assumido', 'comentado', 'resolvido', 'encerrado']);
    expect((await api(auditor, 'POST', `/alerts/${a.id}/comments`, { note: 'Sem permissão' })).statusCode).toBe(403);
    // The history cannot be rewritten.
    await expect(ctx.db.updateTable('alert_action').set({ note: 'alterado' }).where('alert_id', '=', a.id).execute()).rejects.toThrow();
  });
});
