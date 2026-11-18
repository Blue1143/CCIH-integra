import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { addDays, shiftMonths, todayIn, zonedInstant } from '@ccih/domain';
import * as m0015 from '../src/db/migrations/0015_consulting_agenda';
import { createOrganization } from '../src/services/organization';
import { resetAlertThrottle } from '../src/services/alerts';
import { TEST_PASSWORD, accessBody, login, setupTestApp, teardown, type Session, type TestContext } from './helpers';

/** Consulting agenda: activities, participants, conflicts, outcomes (with contract deliveries), tasks, alerts, calendar export and scope. */
let ctx: TestContext;
let consultId: string;
let tz: string;
let today: string;
const S = {} as Record<'dono' | 'beta' | 'hospital' | 'gestor' | 'c1' | 'c2' | 'assist', Session>;
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
const at = (day: string, hour: number) => zonedInstant(day, hour, tz).toISOString();

let clientA: string;
let clientB: string;
let estA: string;
let estB: string;
let serviceA: string;
const ids = {} as Record<'gestor' | 'c1' | 'c2' | 'assist', string>;
const activity = (over: Record<string, unknown> = {}) => ({
  kind: 'visita_tecnica', mode: 'presencial', title: 'Visita mensal à CCIH', description: null, startsAt: at(addDays(today, 2), 9), endsAt: at(addDays(today, 2), 12),
  location: null, establishmentId: estA, contractServiceId: null, responsibleId: ids.c1, participantIds: [], allowOverlap: false, reason: null, rowVersion: null, ...over,
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
  ids.gestor = await userId('gestor.alfa');
  ids.c1 = await userId('consultor1.alfa');
  ids.c2 = await userId('consultor2.alfa');
  ids.assist = await userId('assist.alfa');
  tz = (await ctx.db.selectFrom('institution').select('timezone').where('id', '=', consultId).executeTakeFirstOrThrow()).timezone;
  today = todayIn(tz);
  const address = { street: null, number: null, district: null, city: 'Campinas', state: 'SP', zip: null };
  const client = async (name: string) => (await call(S.assist, 'POST', '/consulting/clients', { legalName: name, tradeName: null, cnpj: null, kind: 'hospital', status: 'ativo', email: null, phone: null, servicesSummary: null, rowVersion: null, address })).json().id as string;
  clientA = await client('Hospital Alfa Um (teste)');
  clientB = await client('Hospital Alfa Dois (teste)');
  const est = async (c: string) => (await call(S.assist, 'POST', `/consulting/clients/${c}/establishments`, { name: 'Unidade Centro', cnes: null, cnpj: null, kind: 'hospital', beds: null, address, active: true, rowVersion: null })).json().establishments[0].id as string;
  estA = await est(clientA);
  estB = await est(clientB);
  expect((await call(S.gestor, 'POST', `/consulting/clients/${clientA}/assignments`, { userId: ids.c1, role: 'responsavel', specialty: 'ccih', startsOn: null, reason: 'Início do atendimento' })).statusCode).toBe(201);
  expect((await call(S.gestor, 'POST', `/consulting/clients/${clientB}/assignments`, { userId: ids.c2, role: 'responsavel', specialty: 'ccih', startsOn: null, reason: 'Início do atendimento' })).statusCode).toBe(201);
  // A signed contract of client A with monthly visits.
  const p = (await call(S.gestor, 'POST', `/consulting/clients/${clientA}/contracts`, {
    title: 'Assessoria em CCIH', startsOn: shiftMonths(today, -2), endsOn: shiftMonths(today, 10), autoRenew: false, renewalNoticeDays: 60, responsibleId: null, scopeNotes: null, rowVersion: null,
    services: [{ id: null, area: 'ccih', kind: 'visita_tecnica', description: 'Visita técnica mensal', establishmentId: null, unit: 'visitas', quantity: 2, period: 'mensal' }],
  })).json();
  const signed = (await call(S.gestor, 'POST', `/consulting/contracts/${p.id}/status`, { status: 'vigente', on: null, reason: null, rowVersion: p.rowVersion })).json();
  serviceA = signed.serviceLines[0].id;
}, 120_000);
afterAll(async () => teardown(ctx));

let future: { id: string; rowVersion: number };
let past: { id: string; rowVersion: number };

describe('consulting agenda', () => {
  it('offers, for each client, only the team that sees it, its establishments and the services in force', async () => {
    const o = (await call(S.gestor, 'GET', `/consulting/clients/${clientA}/activity-options`)).json();
    const people = o.people.map((p: { userId: string }) => p.userId);
    expect(people).toEqual(expect.arrayContaining([ids.c1, ids.gestor, ids.assist]));
    expect(people).not.toContain(ids.c2);
    expect(o.establishments.map((e: { id: string }) => e.id)).toEqual([estA]);
    expect(o.services).toEqual([expect.objectContaining({ id: serviceA, frequency: '2 visitas por mês' })]);
    expect((await call(S.c2, 'GET', `/consulting/clients/${clientA}/activity-options`)).statusCode).toBe(404);
  });

  it('schedules activities with validation, the right people and places, and warns about schedule conflicts', async () => {
    const bad = await call(S.c1, 'POST', `/consulting/clients/${clientA}/activities`, activity({ title: 'x', endsAt: at(addDays(today, 2), 8) }));
    expect(bad.json().fields.map((f: { path: string }) => f.path)).toEqual(['title', 'endsAt']);
    expect((await call(S.c1, 'POST', `/consulting/clients/${clientA}/activities`, activity({ responsibleId: ids.c2 }))).json().fields[0].path).toBe('responsibleId');
    expect((await call(S.c1, 'POST', `/consulting/clients/${clientA}/activities`, activity({ establishmentId: estB }))).json().fields[0].path).toBe('establishmentId');
    const r = await call(S.c1, 'POST', `/consulting/clients/${clientA}/activities`, activity({ participantIds: [ids.gestor], contractServiceId: serviceA }));
    expect(r.statusCode, r.body).toBe(201);
    future = r.json();
    expect(r.json()).toMatchObject({ status: 'agendada', situation: 'agendada', clientName: 'Hospital Alfa Um (teste)', establishmentName: 'Unidade Centro', serviceDescription: 'Visita técnica mensal', contractCode: expect.stringMatching(/^CT-/) });
    expect(r.json().participants.map((p: { userId: string }) => p.userId)).toEqual([ids.gestor]);
    expect(r.json().events[0]).toMatchObject({ kind: 'agendada' });
    // The manager already has that time taken: conflict shown, then accepted on purpose.
    const clash = activity({ title: 'Reunião de comissão', kind: 'reuniao', mode: 'remoto', establishmentId: null, responsibleId: ids.gestor, startsAt: at(addDays(today, 2), 11), endsAt: at(addDays(today, 2), 13) });
    const c = await call(S.gestor, 'POST', `/consulting/clients/${clientA}/activities`, clash);
    expect(c.statusCode).toBe(409);
    expect(c.json()).toMatchObject({ error: 'conflito_agenda' });
    expect(c.json().fields[0].message).toMatch(/gestor\.alfa \(teste\): Visita mensal à CCIH/);
    expect((await call(S.gestor, 'POST', `/consulting/clients/${clientA}/activities`, { ...clash, allowOverlap: true })).statusCode).toBe(201);
    // Ending when the other starts is not a conflict.
    expect((await call(S.gestor, 'POST', `/consulting/clients/${clientA}/activities`, { ...clash, startsAt: at(addDays(today, 2), 12), endsAt: at(addDays(today, 2), 13), responsibleId: ids.c1 })).statusCode).toBe(201);
    // Out of scope: another consultant and other organizations.
    expect((await call(S.c2, 'POST', `/consulting/clients/${clientA}/activities`, activity())).statusCode).toBe(404);
    expect((await call(S.c2, 'GET', `/consulting/activities/${future.id}`)).statusCode).toBe(404);
    expect((await call(S.beta, 'GET', `/consulting/activities/${future.id}`)).statusCode).toBe(404);
    expect((await call(S.hospital, 'GET', '/consulting/activities')).statusCode).toBe(404);
  });

  it('reschedules with a reason and keeps the history', async () => {
    const body = activity({ participantIds: [ids.gestor], contractServiceId: serviceA, startsAt: at(addDays(today, 3), 9), endsAt: at(addDays(today, 3), 12), rowVersion: future.rowVersion });
    expect((await call(S.c1, 'PUT', `/consulting/activities/${future.id}`, body)).json().fields[0].path).toBe('reason');
    const r = await call(S.c1, 'PUT', `/consulting/activities/${future.id}`, { ...body, reason: 'Pedido do hospital' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().events[0]).toMatchObject({ kind: 'remarcada', detail: 'Pedido do hospital' });
    future = r.json();
    expect((await call(S.c1, 'PUT', `/consulting/activities/${future.id}`, { ...body, reason: 'x', rowVersion: 1 })).statusCode).toBe(409);
  });

  it('records what happened: a realized visit becomes a delivery of the contract and leaves follow-up tasks', async () => {
    const yesterday = addDays(today, -1);
    past = (await call(S.c1, 'POST', `/consulting/clients/${clientA}/activities`, activity({ title: 'Visita de ontem', contractServiceId: serviceA, startsAt: at(yesterday, 9), endsAt: at(yesterday, 11) }))).json();
    // Not before it starts.
    expect((await call(S.c1, 'POST', `/consulting/activities/${future.id}/outcome`, { status: 'realizada', summary: 'Antes da hora, não deveria', detail: null, actualMinutes: 60, reason: null, registerDelivery: false, tasks: [], rowVersion: future.rowVersion })).json().fields[0].path).toBe('status');
    // The assistant schedules and cancels, but does not record a realization.
    const outcome = { status: 'realizada', summary: 'Revisão do plano de ação e das notificações', detail: 'Pontos tratados com a CCIH.', actualMinutes: 120, reason: null, registerDelivery: true,
      tasks: [{ description: 'Enviar a ata da visita', ownerId: ids.c1, dueOn: addDays(today, 3) }], rowVersion: past.rowVersion };
    expect((await call(S.assist, 'POST', `/consulting/activities/${past.id}/outcome`, outcome)).statusCode).toBe(403);
    expect((await call(S.c1, 'POST', `/consulting/activities/${past.id}/outcome`, { ...outcome, tasks: [{ description: 'Fora da equipe', ownerId: ids.c2, dueOn: addDays(today, 3) }] })).json().fields[0].path).toBe('tasks.0.ownerId');
    const r = await call(S.c1, 'POST', `/consulting/activities/${past.id}/outcome`, outcome);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: 'realizada', actualMinutes: 120, recordedBy: 'consultor1.alfa (teste)', deliveryId: expect.any(String), openTasks: 1 });
    expect(r.json().tasks[0]).toMatchObject({ description: 'Enviar a ata da visita', status: 'aberta', late: false });
    const delivery = await ctx.db.selectFrom('contract_delivery').selectAll().where('activity_id', '=', past.id).executeTakeFirstOrThrow();
    expect(delivery).toMatchObject({ service_id: serviceA, occurred_on: yesterday, quantity: '1.00' });
    const client = (await call(S.gestor, 'GET', `/consulting/clients/${clientA}`)).json();
    expect(client.events.find((e: { kind: string }) => e.kind === 'atividade')).toMatchObject({ summary: 'Visita técnica realizada: Visita de ontem.', occurredOn: yesterday });
    // Final: neither the API nor the database change a recorded activity.
    expect((await call(S.c1, 'POST', `/consulting/activities/${past.id}/outcome`, { ...outcome, rowVersion: r.json().rowVersion })).statusCode).toBe(409);
    await expect(sql`UPDATE consulting_activity SET title = 'outro' WHERE id = ${past.id}`.execute(ctx.db)).rejects.toThrow(/não é alterada/);
    await expect(sql`DELETE FROM consulting_activity WHERE id = ${future.id}`.execute(ctx.db)).rejects.toThrow(/não são apagadas/);
    await expect(sql`UPDATE consulting_activity_event SET summary = 'x'`.execute(ctx.db)).rejects.toThrow();
    // A delivery can only be registered once per activity.
    await expect(ctx.db.insertInto('contract_delivery').values({ institution_id: consultId, service_id: serviceA, occurred_on: yesterday, quantity: 1, description: 'Duplicada', created_by_name: 'x', activity_id: past.id }).execute()).rejects.toThrow();
  });

  it('cancels with a reason (the assistant may), without delivery', async () => {
    const a = (await call(S.assist, 'POST', `/consulting/clients/${clientA}/activities`, activity({ title: 'A cancelar', startsAt: at(addDays(today, 5), 9), endsAt: at(addDays(today, 5), 10) }))).json();
    const body = { status: 'cancelada', summary: null, detail: null, actualMinutes: null, reason: null, registerDelivery: false, tasks: [], rowVersion: a.rowVersion };
    expect((await call(S.assist, 'POST', `/consulting/activities/${a.id}/outcome`, body)).json().fields[0].path).toBe('reason');
    const r = await call(S.assist, 'POST', `/consulting/activities/${a.id}/outcome`, { ...body, reason: 'Hospital pediu adiamento' });
    expect(r.json()).toMatchObject({ status: 'cancelada', closeReason: 'Hospital pediu adiamento', deliveryId: null });
  });

  it('closes tasks once, by the owner or whoever records activities, within the client scope', async () => {
    const mine = (await call(S.c1, 'GET', '/consulting/tasks?mine=1&status=aberta')).json();
    expect(mine.rows.map((t: { description: string }) => t.description)).toEqual(['Enviar a ata da visita']);
    const task = mine.rows[0];
    expect((await call(S.c2, 'POST', `/consulting/tasks/${task.id}/close`, { status: 'concluida', note: 'Feito', rowVersion: task.rowVersion })).statusCode).toBe(404);
    expect((await call(S.assist, 'POST', `/consulting/tasks/${task.id}/close`, { status: 'concluida', note: 'Feito', rowVersion: task.rowVersion })).statusCode).toBe(403);
    const r = await call(S.c1, 'POST', `/consulting/tasks/${task.id}/close`, { status: 'concluida', note: 'Ata enviada por e-mail', rowVersion: task.rowVersion });
    expect(r.json()).toMatchObject({ status: 'concluida', closedNote: 'Ata enviada por e-mail', closedBy: 'consultor1.alfa (teste)' });
    expect((await call(S.c1, 'POST', `/consulting/tasks/${task.id}/close`, { status: 'cancelada', note: 'De novo', rowVersion: r.json().rowVersion })).statusCode).toBe(409);
    await expect(sql`UPDATE consulting_task SET description = 'x' WHERE id = ${task.id}`.execute(ctx.db)).rejects.toThrow(/encerrar/);
    expect((await call(S.gestor, 'GET', `/consulting/activities/${past.id}`)).json().events[0]).toMatchObject({ kind: 'pendencia_encerrada' });
    // A task can be added later to a realized activity.
    expect((await call(S.c1, 'POST', `/consulting/activities/${past.id}/tasks`, { description: 'Revisar o POP de higiene', ownerId: ids.c1, dueOn: addDays(today, 7) })).statusCode).toBe(201);
  });

  it('lists the agenda by period, person and situation within the scope of each profile', async () => {
    const week = (from: string, to: string, extra = '') => `/consulting/activities?from=${encodeURIComponent(at(from, 0))}&to=${encodeURIComponent(at(to, 0))}${extra}`;
    const all = (await call(S.gestor, 'GET', week(addDays(today, -2), addDays(today, 8)))).json();
    expect(all.total).toBe(5);
    expect((await call(S.gestor, 'GET', week(addDays(today, -2), addDays(today, 8), '&mine=1'))).json().total).toBe(2);
    expect((await call(S.gestor, 'GET', week(addDays(today, -2), addDays(today, 8), '&status=cancelada'))).json().total).toBe(1);
    expect((await call(S.c2, 'GET', week(addDays(today, -2), addDays(today, 8)))).json().total).toBe(0);
    expect((await call(S.beta, 'GET', '/consulting/activities')).json().total).toBe(0);
  });

  it('exports the agenda as iCalendar for the person, within the scope', async () => {
    const r = await call(S.c1, 'GET', '/consulting/agenda.ics?mine=1');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/calendar/);
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="agenda-/);
    expect(r.body).toContain(`UID:${future.id}@ccih-integra`);
    expect(r.body).toContain('X-WR-CALNAME:Agenda de consultor1.alfa (teste)');
    expect((await call(S.c2, 'GET', '/consulting/agenda.ics')).body).not.toContain(future.id);
  });

  it('raises alerts for activities left without record and late tasks, only for who sees the client', async () => {
    // Scheduled two days ago, never recorded; and a task already past its due date.
    const old = (await call(S.c1, 'POST', `/consulting/clients/${clientA}/activities`, activity({ title: 'Esquecida', startsAt: at(addDays(today, -3), 9), endsAt: at(addDays(today, -3), 10) }))).json();
    await ctx.db.insertInto('consulting_task').values({ institution_id: consultId, client_id: clientA, activity_id: past.id, description: 'Atrasada de propósito', owner_id: ids.c1, due_on: addDays(today, -2), created_by_name: 'teste' }).execute();
    resetAlertThrottle(consultId);
    const forC1 = (await call(S.c1, 'GET', '/alerts?pageSize=100')).json().rows;
    expect(forC1.find((a: { kind: string; entityId: string }) => a.kind === 'atividade_sem_registro' && a.entityId === old.id)).toMatchObject({ link: `/consultoria/agenda/${old.id}` });
    expect(forC1.some((a: { kind: string }) => a.kind === 'pendencia_atrasada')).toBe(true);
    expect((await call(S.c2, 'GET', '/alerts?pageSize=100')).json().rows.some((a: { kind: string }) => a.kind === 'atividade_sem_registro')).toBe(false);
    // Recording the activity closes its alert.
    await call(S.c1, 'POST', `/consulting/activities/${old.id}/outcome`, { status: 'nao_realizada', summary: null, detail: null, actualMinutes: null, reason: 'Cliente não compareceu', registerDelivery: false, tasks: [], rowVersion: old.rowVersion });
    resetAlertThrottle(consultId);
    const after = (await call(S.c1, 'GET', '/alerts?pageSize=100')).json().rows;
    expect(after.some((a: { kind: string; entityId: string; status: string }) => a.kind === 'atividade_sem_registro' && a.entityId === old.id && a.status !== 'encerrado')).toBe(false);
  });

  it('sweeps every agenda route as a consultant with identifiers of another consultant client', async () => {
    const acts = await ctx.db.selectFrom('consulting_activity').select('id').where('client_id', '=', clientA).execute();
    const tasks = await ctx.db.selectFrom('consulting_task').select('id').where('client_id', '=', clientA).execute();
    const idsA = [clientA, ...acts.map((a) => a.id), ...tasks.map((t) => t.id)];
    const routes = ctx.app.routeIndex.filter((r) => /\/api\/consulting\/(activities|tasks|clients\/:id\/(activities|activity-options))/.test(r.url) && r.url.includes(':') && r.method !== 'HEAD');
    expect(routes.length).toBeGreaterThanOrEqual(7);
    const problems: string[] = [];
    for (const r of routes) {
      for (const id of idsA) {
        const res = await ctx.app.inject({ method: r.method as 'GET', url: r.url.replace(/:[a-zA-Z]+/g, id), headers: S.c2.headers, ...(r.method === 'GET' ? {} : { payload: {} }) });
        if (res.statusCode < 400) problems.push(`${r.method} ${r.url} → ${res.statusCode}`);
        if (idsA.some((x) => res.body.includes(x))) problems.push(`${r.method} ${r.url} devolveu identificador fora do escopo`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('isolates the tables in the database and the migration gives existing consultancies the agenda permissions (down and up)', async () => {
    const other = await ctx.db.selectFrom('institution').select('id').where('name', '=', 'Consultoria Beta (teste)').executeTakeFirstOrThrow();
    const row = { client_id: clientA, kind: 'reuniao', mode: 'remoto' as const, title: 'Intrusão', starts_at: new Date(), ends_at: new Date(Date.now() + 3_600_000), responsible_id: ids.c1, created_by_name: 'x', data_origin: 'real' as const };
    await expect(ctx.db.insertInto('consulting_activity').values({ ...row, institution_id: other.id }).execute()).rejects.toThrow();
    await expect(ctx.db.insertInto('consulting_activity').values({ ...row, institution_id: ctx.institutionId }).execute()).rejects.toThrow();
    const owner = ctx.owner as unknown as Kysely<unknown>;
    await m0015.down(owner);
    // Deliveries made from the agenda stay in the contract.
    expect((await ctx.db.selectFrom('contract_delivery').select('id').where('service_id', '=', serviceA).execute()).length).toBe(1);
    await m0015.up(owner);
    const roles = await ctx.db.selectFrom('role').select(['code', 'permissions']).where('institution_id', '=', consultId).execute();
    const of = (code: string) => roles.find((r) => r.code === code)!.permissions;
    expect(of('consultor')).toEqual(expect.arrayContaining(['consultoria:agenda:view', 'consultoria:agenda:edit', 'consultoria:agenda:record']));
    expect(of('assistente_consultoria')).not.toContain('consultoria:agenda:record');
    expect(of('financeiro_consultoria')).not.toContain('consultoria:agenda:view');
  });
});
