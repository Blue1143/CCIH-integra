import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { addDays, shiftMonths, todayIn } from '@ccih/domain';
import * as m0014 from '../src/db/migrations/0014_consulting_contracts';
import { createOrganization } from '../src/services/organization';
import { resetAlertThrottle } from '../src/services/alerts';
import { topicOfEntity } from '../src/realtime/outbox';
import { TEST_PASSWORD, accessBody, login, setupTestApp, teardown, type Session, type TestContext } from './helpers';

/** Consulting contracts: proposals, signature, amendments, deliveries (planned × done), financial terms, alerts and scope. */
let ctx: TestContext;
let consultId: string;
const S = {} as Record<'dono' | 'beta' | 'hospital' | 'gestor' | 'c1' | 'c2' | 'assist' | 'fin', Session>;
const call = (s: Session, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) =>
  ctx.app.inject({ method, url: `/api${path}`, headers: s.headers, ...(body !== undefined ? { payload: body as object } : {}) });

async function createUser(owner: Session, loginName: string, functionRole: string) {
  const res = await call(owner, 'POST', '/users', { ...accessBody({ functionRole, scopeAll: true, sectorIds: [] }), login: loginName, displayName: `${loginName} (teste)` });
  expect(res.statusCode, res.body).toBe(201);
  const { temporaryPassword } = res.json();
  const s = await login(ctx.app, loginName, temporaryPassword);
  expect((await call(s, 'POST', '/auth/password', { currentPassword: temporaryPassword, newPassword: TEST_PASSWORD })).statusCode).toBeLessThan(300);
  return login(ctx.app, loginName);
}
const userId = async (l: string) => (await ctx.db.selectFrom('app_user').select('id').where('login', '=', l).executeTakeFirstOrThrow()).id;

let today: string;
let clientA: string;
let clientB: string;
let estA: string;
let contract: { id: string; rowVersion: number; serviceLines: Array<{ id: string; description: string; endsOn: string | null; replacesId: string | null; plan: unknown }> };

const visit = { id: null, area: 'ccih', kind: 'visita_tecnica', description: 'Visita técnica à CCIH', establishmentId: null, unit: 'visitas', quantity: 2, period: 'mensal' };
const proposal = (over: Record<string, unknown> = {}) => ({
  title: 'Assessoria em CCIH', startsOn: null, endsOn: null, autoRenew: false, renewalNoticeDays: 60, responsibleId: null, scopeNotes: 'Escopo em negociação', services: [visit], rowVersion: null, ...over,
});

beforeAll(async () => {
  ctx = await setupTestApp();
  consultId = (await createOrganization(ctx.db, { type: 'consultoria', name: 'Consultoria Alfa (teste)', founder: { login: 'dono.alfa', password: TEST_PASSWORD, displayName: 'Dono da Alfa' } })).institutionId;
  await createOrganization(ctx.db, { type: 'consultoria', name: 'Consultoria Beta (teste)', founder: { login: 'dono.beta', password: TEST_PASSWORD, displayName: 'Dono da Beta' } });
  S.dono = await login(ctx.app, 'dono.alfa');
  S.beta = await login(ctx.app, 'dono.beta');
  S.hospital = await login(ctx.app, 'admin');
  S.gestor = await createUser(S.dono, 'gestor.alfa', 'gestor_consultoria');
  S.c1 = await createUser(S.dono, 'consultor1.alfa', 'consultor');
  S.c2 = await createUser(S.dono, 'consultor2.alfa', 'consultor');
  S.assist = await createUser(S.dono, 'assist.alfa', 'assistente_consultoria');
  S.fin = await createUser(S.dono, 'fin.alfa', 'financeiro_consultoria');
  const inst = await ctx.db.selectFrom('institution').select('timezone').where('id', '=', consultId).executeTakeFirstOrThrow();
  today = todayIn(inst.timezone);
  const client = (body: Record<string, unknown>) => call(S.assist, 'POST', '/consulting/clients', {
    tradeName: null, cnpj: null, kind: 'hospital', email: null, phone: null, servicesSummary: null, rowVersion: null,
    address: { street: null, number: null, district: null, city: 'Campinas', state: 'SP', zip: null }, ...body,
  });
  clientA = (await client({ legalName: 'Hospital Alfa Um (teste)', status: 'prospecto' })).json().id;
  clientB = (await client({ legalName: 'Hospital Alfa Dois (teste)', status: 'ativo' })).json().id;
  estA = (await call(S.assist, 'POST', `/consulting/clients/${clientA}/establishments`, {
    name: 'Unidade Centro', cnes: null, cnpj: null, kind: 'hospital', beds: null, address: { street: null, number: null, district: null, city: null, state: null, zip: null }, active: true, rowVersion: null,
  })).json().establishments[0].id;
  expect((await call(S.gestor, 'POST', `/consulting/clients/${clientA}/assignments`, { userId: await userId('consultor1.alfa'), role: 'responsavel', specialty: 'ccih', startsOn: null, reason: 'Início do atendimento' })).statusCode).toBe(201);
}, 120_000);
afterAll(async () => teardown(ctx));

describe('consulting contracts', () => {
  it('registers a proposal with a sequential code, validating services and establishments of the client', async () => {
    const bad = await call(S.assist, 'POST', `/consulting/clients/${clientA}/contracts`, proposal({ title: 'X', services: [{ ...visit, quantity: 1.5 }] }));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().fields.map((f: { path: string }) => f.path)).toEqual(['title', 'services.0.quantity']);
    const foreignEst = (await ctx.db.selectFrom('client_establishment').select('id').where('client_id', '!=', clientA).executeTakeFirst())?.id;
    if (foreignEst) expect((await call(S.assist, 'POST', `/consulting/clients/${clientA}/contracts`, proposal({ services: [{ ...visit, establishmentId: foreignEst }] }))).statusCode).toBe(400);
    expect((await call(S.assist, 'POST', `/consulting/clients/${clientA}/contracts`, proposal({ responsibleId: await userId('assist.alfa') }))).json().fields[0].path).toBe('responsibleId');
    const r = await call(S.assist, 'POST', `/consulting/clients/${clientA}/contracts`, proposal({ responsibleId: await userId('gestor.alfa'), services: [visit, { ...visit, kind: 'documentacao', description: 'Revisão de POPs', unit: 'entregas', quantity: 1, period: 'contrato', establishmentId: estA }] }));
    expect(r.statusCode, r.body).toBe(201);
    contract = r.json();
    expect(r.json()).toMatchObject({ code: `CT-${today.slice(0, 4)}-001`, status: 'proposta', situation: 'proposta', clientName: 'Hospital Alfa Um (teste)', responsible: 'gestor.alfa (teste)' });
    expect(r.json().serviceLines.map((l: { establishmentName: string | null; plan: unknown }) => [l.establishmentName, l.plan])).toEqual([[null, null], ['Unidade Centro', null]]);
    expect(r.json().history[0].summary).toMatch(/Proposta CT-.*-001 cadastrada/);
    // A second proposal gets the next number.
    const second = await call(S.gestor, 'POST', `/consulting/clients/${clientB}/contracts`, proposal({ title: 'Diagnóstico de CME' }));
    expect(second.json().code).toBe(`CT-${today.slice(0, 4)}-002`);
  });

  it('edits a proposal freely (lines added and removed) and signs it only with start and services', async () => {
    const lines = contract.serviceLines;
    const edited = await call(S.assist, 'PUT', `/consulting/contracts/${contract.id}`, proposal({
      services: [{ ...visit, id: lines[0]!.id, quantity: 4 }], startsOn: null, rowVersion: contract.rowVersion,
    }));
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().serviceLines.map((l: { quantity: number }) => l.quantity)).toEqual([4]);
    const noStart = await call(S.gestor, 'POST', `/consulting/contracts/${contract.id}/status`, { status: 'vigente', on: null, reason: null, rowVersion: edited.json().rowVersion });
    expect(noStart.statusCode).toBe(400);
    expect(noStart.json().fields[0].path).toBe('startsOn');
    const startsOn = shiftMonths(today, -3);
    const dated = await call(S.assist, 'PUT', `/consulting/contracts/${contract.id}`, proposal({
      services: [{ ...visit, id: lines[0]!.id, quantity: 2 }], startsOn, endsOn: addDays(today, 20), rowVersion: edited.json().rowVersion,
    }));
    expect((await call(S.c1, 'POST', `/consulting/contracts/${contract.id}/status`, { status: 'vigente', on: null, reason: null, rowVersion: dated.json().rowVersion })).statusCode).toBe(403);
    const signed = await call(S.gestor, 'POST', `/consulting/contracts/${contract.id}/status`, { status: 'vigente', on: addDays(startsOn, -2), reason: null, rowVersion: dated.json().rowVersion });
    expect(signed.statusCode, signed.body).toBe(200);
    contract = signed.json();
    expect(signed.json()).toMatchObject({ status: 'vigente', situation: 'vigente', expiry: 'vencendo', daysToEnd: 20, signedOn: addDays(startsOn, -2) });
    expect(signed.json().serviceLines[0]).toMatchObject({ startsOn, plan: { closedPeriods: 3, plannedClosed: 6, doneClosed: 0 } });
    // The prospect became an active client, and both timelines tell it.
    const client = (await call(S.gestor, 'GET', `/consulting/clients/${clientA}`)).json();
    expect(client.status).toBe('ativo');
    expect(client.events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(['contrato', 'alteracao']));
    // A signed contract is changed only by amendment; the database backs it.
    expect((await call(S.assist, 'PUT', `/consulting/contracts/${contract.id}`, proposal({ rowVersion: contract.rowVersion }))).statusCode).toBe(409);
    await expect(sql`UPDATE contract_service SET quantity = 9 WHERE contract_id = ${contract.id}`.execute(ctx.db)).rejects.toThrow(/aditivo/);
    await expect(sql`DELETE FROM contract_service WHERE contract_id = ${contract.id}`.execute(ctx.db)).rejects.toThrow(/não são apagados/);
  });

  it('records deliveries within the service term and compares them with the planned', async () => {
    const line = contract.serviceLines[0]!;
    const start = shiftMonths(today, -3);
    const deliver = (s: Session, body: Record<string, unknown>) => call(s, 'POST', `/consulting/contract-services/${line.id}/deliveries`, { occurredOn: null, quantity: 1, description: 'Visita mensal', ...body });
    expect((await deliver(S.c1, { occurredOn: '2999-01-01' })).statusCode).toBe(400);
    expect((await deliver(S.c1, { occurredOn: addDays(start, -1) })).json().fields[0].message).toMatch(/Fora da vigência/);
    expect((await deliver(S.c1, { quantity: 0.5 })).json().fields[0].path).toBe('quantity');
    expect((await deliver(S.c2, {})).statusCode).toBe(404);
    expect((await deliver(S.fin, {})).statusCode).toBe(403);
    await deliver(S.c1, { occurredOn: addDays(start, 2), quantity: 2 });
    const r = await deliver(S.c1, { occurredOn: addDays(shiftMonths(start, 1), 2) });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().serviceLines[0].plan).toMatchObject({ plannedClosed: 6, doneClosed: 3 });
    expect(r.json().plannedClosed).toBe(6);
    // A mistaken delivery is voided with a reason (never deleted) and leaves the count.
    const wrong = (await deliver(S.c1, { occurredOn: addDays(shiftMonths(start, 2), 2), description: 'Lançada por engano' })).json().deliveries[0];
    expect((await call(S.c1, 'POST', `/consulting/contract-deliveries/${wrong.id}/void`, { reason: 'x' })).statusCode).toBe(400);
    const voided = await call(S.c1, 'POST', `/consulting/contract-deliveries/${wrong.id}/void`, { reason: 'Registrada no contrato errado' });
    expect(voided.json().deliveries.find((d: { id: string }) => d.id === wrong.id)).toMatchObject({ voidReason: 'Registrada no contrato errado', voidedBy: 'consultor1.alfa (teste)' });
    expect(voided.json().serviceLines[0].plan.doneClosed).toBe(3);
    expect((await call(S.c1, 'POST', `/consulting/contract-deliveries/${wrong.id}/void`, { reason: 'De novo, por engano' })).statusCode).toBe(409);
    await expect(sql`DELETE FROM contract_delivery WHERE id = ${wrong.id}`.execute(ctx.db)).rejects.toThrow(/não são apagadas/);
    await expect(sql`UPDATE contract_delivery SET quantity = 5 WHERE service_id = ${line.id}`.execute(ctx.db)).rejects.toThrow(/anular/);
  });

  it('applies amendments: new term, changed frequency (old line ended, new one linked) and history kept', async () => {
    const c = (await call(S.gestor, 'GET', `/consulting/contracts/${contract.id}`)).json();
    const line = c.serviceLines[0];
    const body = { kinds: ['prazo'], description: 'Prorrogação por mais 12 meses', signedOn: today, effectiveOn: today, addServices: [], changeServices: [], endServices: [], rowVersion: c.rowVersion };
    expect((await call(S.gestor, 'POST', `/consulting/contracts/${contract.id}/amendments`, body)).json().fields[0].path).toBe('newEndsOn');
    const newEnd = addDays(shiftMonths(today, 12), 20);
    const r = await call(S.gestor, 'POST', `/consulting/contracts/${contract.id}/amendments`, {
      ...body, kinds: ['prazo', 'escopo'], newEndsOn: newEnd, changeServices: [{ id: line.id, quantity: 4, period: 'mensal' }],
      addServices: [{ ...visit, kind: 'treinamento', description: 'Treinamento da equipe', unit: 'horas', quantity: 1.5, period: 'trimestral' }],
    });
    expect(r.statusCode, r.body).toBe(201);
    const a = r.json();
    expect(a).toMatchObject({ endsOn: newEnd, expiry: 'em_dia', amendments: 1 });
    expect(a.amendmentList[0]).toMatchObject({ number: 1, kinds: ['prazo', 'escopo'] });
    expect(a.amendmentList[0].changes.join(' ')).toMatch(/Término: .* → .*Serviço incluído: Treinamento da equipe \(1,5 horas por trimestre\).*Serviço alterado/);
    const old = a.serviceLines.find((l: { id: string }) => l.id === line.id);
    expect(old.endsOn).toBe(addDays(today, -1));
    const replacement = a.serviceLines.find((l: { replacesId: string | null }) => l.replacesId === line.id);
    expect(replacement).toMatchObject({ quantity: 4, startsOn: today, endsOn: null });
    // The deliveries already made stay with the old line.
    expect(old.plan.doneClosed).toBe(3);
    contract = a;
    await expect(sql`UPDATE contract_amendment SET description = 'x'`.execute(ctx.db)).rejects.toThrow();
    // Ending a line twice, or amending a line already ended, is refused.
    expect((await call(S.gestor, 'POST', `/consulting/contracts/${contract.id}/amendments`, { ...body, kinds: ['escopo'], endServices: [line.id], rowVersion: a.rowVersion })).statusCode).toBe(400);
  });

  it('keeps the financial terms to the financial profile and the administrator', async () => {
    const asGestor = (await call(S.gestor, 'GET', `/consulting/contracts/${contract.id}`)).json();
    expect(asGestor).not.toHaveProperty('financial');
    expect((await call(S.c1, 'GET', `/consulting/contracts/${contract.id}`)).json()).not.toHaveProperty('financial');
    const body = { basis: 'mensal', amountCents: 450000, billingDay: 10, paymentTerms: 'Boleto, 15 dias', adjustmentRule: 'IPCA anual', notes: null, rowVersion: null };
    expect((await call(S.gestor, 'PUT', `/consulting/contracts/${contract.id}/financial`, body)).statusCode).toBe(403);
    expect((await call(S.fin, 'PUT', `/consulting/contracts/${contract.id}/financial`, { ...body, billingDay: 40 })).statusCode).toBe(400);
    const r = await call(S.fin, 'PUT', `/consulting/contracts/${contract.id}/financial`, body);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().financial).toMatchObject({ basis: 'mensal', amountCents: 450000, billingDay: 10, rowVersion: 1, updatedBy: 'fin.alfa (teste)' });
    expect((await call(S.fin, 'PUT', `/consulting/contracts/${contract.id}/financial`, body)).statusCode).toBe(409);
    expect((await call(S.dono, 'GET', `/consulting/contracts/${contract.id}`)).json().financial.amountCents).toBe(450000);
    // The financial profile cannot change the contract itself.
    expect((await call(S.fin, 'POST', `/consulting/contracts/${contract.id}/status`, { status: 'suspenso', on: null, reason: 'Inadimplência', rowVersion: contract.rowVersion })).statusCode).toBe(403);
    // The values never reach the realtime stream of profiles without the permission (topic permission).
    expect(topicOfEntity('contract_financial')).toMatchObject({ topic: 'consultoria', permission: 'consultoria:contracts:financial' });
  });

  it('raises expiry alerts within the client scope and closes them when the term is renewed', async () => {
    // A contract of client B ending in 10 days (client B has no consultant).
    const p = (await call(S.gestor, 'POST', `/consulting/clients/${clientB}/contracts`, proposal({ startsOn: shiftMonths(today, -6), endsOn: addDays(today, 10) }))).json();
    const signedB = (await call(S.gestor, 'POST', `/consulting/contracts/${p.id}/status`, { status: 'vigente', on: null, reason: null, rowVersion: p.rowVersion })).json();
    resetAlertThrottle(consultId);
    const forGestor = (await call(S.gestor, 'GET', '/alerts?pageSize=100')).json().rows.filter((a: { kind: string }) => a.kind.startsWith('contrato_'));
    expect(forGestor.map((a: { kind: string; entityId: string }) => `${a.kind}:${a.entityId}`)).toEqual(expect.arrayContaining([`contrato_vencendo:${p.id}`]));
    const near = forGestor.find((a: { entityId: string }) => a.entityId === p.id);
    expect(near).toMatchObject({ priority: 'alta', link: `/consulting/contratos/${p.id}`.replace('/consulting/', '/consultoria/') });
    // Consultant 1 answers for client A only: does not see client B's alert.
    const forC1 = (await call(S.c1, 'GET', '/alerts?pageSize=100')).json().rows.map((a: { entityId: string }) => a.entityId);
    expect(forC1).not.toContain(p.id);
    expect((await call(S.c1, 'GET', `/alerts/${near.id}`)).statusCode).toBe(404);
    // Below-plan deliveries of client A's line in its last closed period are raised for consultant 1.
    expect((await call(S.c1, 'GET', '/alerts?pageSize=100')).json().rows.some((a: { kind: string }) => a.kind === 'contrato_entregas_abaixo')).toBe(true);
    // Renewal by amendment: the alert closes by itself.
    await call(S.gestor, 'POST', `/consulting/contracts/${p.id}/amendments`, { kinds: ['renovacao'], description: 'Renovação anual do contrato', signedOn: today, effectiveOn: today, newEndsOn: shiftMonths(today, 12), addServices: [], changeServices: [], endServices: [], rowVersion: signedB.rowVersion });
    resetAlertThrottle(consultId);
    await call(S.gestor, 'GET', '/alerts');
    const after = (await call(S.gestor, 'GET', `/alerts/${near.id}`)).json();
    expect(after.status).toBe('encerrado');
    // Hospitals never receive contract alerts and cannot reach contracts.
    expect((await call(S.hospital, 'GET', '/consulting/contracts')).statusCode).toBe(404);
  });

  it('changes status only through the allowed transitions, with a reason', async () => {
    const c = (await call(S.gestor, 'GET', `/consulting/contracts/${contract.id}`)).json();
    expect((await call(S.gestor, 'POST', `/consulting/contracts/${contract.id}/status`, { status: 'recusada', on: null, reason: 'Não se aplica', rowVersion: c.rowVersion })).statusCode).toBe(409);
    expect((await call(S.gestor, 'POST', `/consulting/contracts/${contract.id}/status`, { status: 'suspenso', on: null, reason: null, rowVersion: c.rowVersion })).statusCode).toBe(400);
    const s = await call(S.gestor, 'POST', `/consulting/contracts/${contract.id}/status`, { status: 'suspenso', on: null, reason: 'Pedido do cliente', rowVersion: c.rowVersion });
    expect(s.json()).toMatchObject({ status: 'suspenso' });
    const closed = await call(S.gestor, 'POST', `/consulting/contracts/${contract.id}/status`, { status: 'encerrado', on: null, reason: 'Fim da parceria', rowVersion: s.json().rowVersion });
    expect(closed.json()).toMatchObject({ status: 'encerrado', closedOn: today, closeReason: 'Fim da parceria', expiry: null });
    expect(closed.json().history[0].summary).toMatch(/encerrado/);
    expect((await call(S.gestor, 'POST', `/consulting/contracts/${contract.id}/amendments`, { kinds: ['outro'], description: 'Depois do encerramento', signedOn: today, effectiveOn: today, addServices: [], changeServices: [], endServices: [], rowVersion: closed.json().rowVersion })).statusCode).toBe(409);
  });

  it('lists contracts in the scope of each profile, with filters', async () => {
    const all = (await call(S.gestor, 'GET', '/consulting/contracts')).json();
    expect(all.total).toBe(3);
    expect((await call(S.gestor, 'GET', `/consulting/contracts?clientId=${clientB}`)).json().total).toBe(2);
    expect((await call(S.gestor, 'GET', '/consulting/contracts?status=proposta')).json().rows.map((r: { code: string }) => r.code)).toEqual([`CT-${today.slice(0, 4)}-002`]);
    expect((await call(S.c1, 'GET', '/consulting/contracts')).json().rows.map((r: { clientId: string }) => r.clientId)).toEqual([clientA]);
    expect((await call(S.c2, 'GET', '/consulting/contracts')).json().total).toBe(0);
    expect((await call(S.beta, 'GET', '/consulting/contracts')).json().total).toBe(0);
    expect((await call(S.beta, 'GET', `/consulting/contracts/${contract.id}`)).statusCode).toBe(404);
  });

  it('sweeps every contract route as a consultant with identifiers of contracts of a client not assigned to them', async () => {
    const contracts = await ctx.db.selectFrom('contract').select('id').where('client_id', '=', clientA).execute();
    const lines = await ctx.db.selectFrom('contract_service').select('id').where('contract_id', 'in', contracts.map((c) => c.id)).execute();
    const deliveries = await ctx.db.selectFrom('contract_delivery').select('id').where('service_id', 'in', lines.map((l) => l.id)).execute();
    const ids = [...contracts.map((c) => c.id), ...lines.map((l) => l.id), ...deliveries.map((d) => d.id)];
    const routes = ctx.app.routeIndex.filter((r) => /\/api\/consulting\/(contracts|contract-|clients\/:id\/contracts)/.test(r.url) && r.url.includes(':') && r.method !== 'HEAD');
    expect(routes.length).toBeGreaterThanOrEqual(8);
    const problems: string[] = [];
    for (const r of routes) {
      for (const id of ids) {
        const res = await ctx.app.inject({ method: r.method as 'GET', url: r.url.replace(/:[a-zA-Z]+/g, id), headers: S.c2.headers, ...(r.method === 'GET' ? {} : { payload: {} }) });
        if (res.statusCode < 400) problems.push(`${r.method} ${r.url} → ${res.statusCode}`);
        if (ids.some((x) => res.body.includes(x))) problems.push(`${r.method} ${r.url} devolveu identificador fora do escopo`);
      }
    }
    expect(problems).toEqual([]);
    // With a valid body too.
    expect((await call(S.c2, 'POST', `/consulting/contract-services/${lines[0]!.id}/deliveries`, { occurredOn: null, quantity: 1, description: 'Fora do escopo' })).statusCode).toBe(404);
  });

  it('isolates the tables in the database and the migration adds the permissions to existing consultancies (down and up)', async () => {
    const other = await ctx.db.selectFrom('institution').select('id').where('name', '=', 'Consultoria Beta (teste)').executeTakeFirstOrThrow();
    await expect(ctx.db.insertInto('contract').values({ institution_id: other.id, client_id: clientA, code: 'X-1', title: 'Intrusão', status: 'proposta', created_by_name: 'x', data_origin: 'real' }).execute()).rejects.toThrow();
    await expect(ctx.db.insertInto('contract').values({ institution_id: ctx.institutionId, client_id: clientA, code: 'X-2', title: 'Hospital', status: 'proposta', created_by_name: 'x', data_origin: 'real' }).execute()).rejects.toThrow();
    const owner = ctx.owner as unknown as Kysely<unknown>;
    await m0014.down(owner);
    const admin = await ctx.db.selectFrom('role').select('permissions').where('institution_id', '=', consultId).where('code', '=', 'admin').executeTakeFirstOrThrow();
    expect(admin.permissions.some((p) => p.startsWith('consultoria:contracts:'))).toBe(false);
    await m0014.up(owner);
    const roles = await ctx.db.selectFrom('role').select(['code', 'permissions']).where('institution_id', '=', consultId).execute();
    const of = (code: string) => roles.find((r) => r.code === code)!.permissions;
    expect(of('admin')).toEqual(expect.arrayContaining(['consultoria:contracts:financial', 'consultoria:contracts:edit']));
    expect(of('consultor')).toEqual(expect.arrayContaining(['consultoria:contracts:view', 'consultoria:contracts:deliveries']));
    expect(of('consultor')).not.toContain('consultoria:contracts:financial');
    expect(of('gestor_consultoria')).not.toContain('consultoria:contracts:financial');
    expect(of('financeiro_consultoria')).toEqual(expect.arrayContaining(['consultoria:contracts:financial']));
  });
});
