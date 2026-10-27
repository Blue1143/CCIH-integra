import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import * as m0013 from '../src/db/migrations/0013_consulting_clients';
import * as m0014 from '../src/db/migrations/0014_consulting_contracts';
import { createOrganization } from '../src/services/organization';
import { TEST_PASSWORD, accessBody, login, setupTestApp, teardown, type Session, type TestContext } from './helpers';

/** Consulting portfolio: clients, contacts, establishments, units, assignments and client scope. */
let ctx: TestContext;
let consultId: string;
let otherConsultId: string;
const S = {} as Record<'dono' | 'beta' | 'hospital' | 'gestor' | 'c1' | 'c2' | 'assist', Session>;
const call = (s: Session, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) =>
  ctx.app.inject({ method, url: `/api${path}`, headers: s.headers, ...(body !== undefined ? { payload: body as object } : {}) });

const address = { street: 'Rua das Flores', number: '100', district: 'Centro', city: 'Campinas', state: 'SP', zip: '13010-000' };
const clientBody = (over: Record<string, unknown> = {}) => ({
  legalName: 'Hospital São Lucas Ltda (teste)', tradeName: 'Hospital São Lucas', cnpj: '11.444.777/0001-61', kind: 'hospital', status: 'ativo',
  email: 'contato@saolucas.exemplo', phone: '(19) 3333-4444', address, servicesSummary: 'Consultoria em CCIH e CME', rowVersion: null, ...over,
});

async function createUser(owner: Session, loginName: string, functionRole: string) {
  const res = await call(owner, 'POST', '/users', { ...accessBody({ functionRole, scopeAll: true, sectorIds: [] }), login: loginName, displayName: `${functionRole} (teste)` });
  expect(res.statusCode, res.body).toBe(201);
  const { temporaryPassword } = res.json();
  // First access with the temporary password, then the user's own password.
  const s = await login(ctx.app, loginName, temporaryPassword);
  expect((await call(s, 'POST', '/auth/password', { currentPassword: temporaryPassword, newPassword: TEST_PASSWORD })).statusCode).toBeLessThan(300);
  return login(ctx.app, loginName);
}

beforeAll(async () => {
  ctx = await setupTestApp();
  consultId = (await createOrganization(ctx.db, { type: 'consultoria', name: 'Consultoria Alfa (teste)', founder: { login: 'dono.alfa', password: TEST_PASSWORD, displayName: 'Dono da Alfa' } })).institutionId;
  otherConsultId = (await createOrganization(ctx.db, { type: 'consultoria', name: 'Consultoria Beta (teste)', founder: { login: 'dono.beta', password: TEST_PASSWORD, displayName: 'Dono da Beta' } })).institutionId;
  S.dono = await login(ctx.app, 'dono.alfa');
  S.beta = await login(ctx.app, 'dono.beta');
  S.hospital = await login(ctx.app, 'admin');
  S.gestor = await createUser(S.dono, 'gestor.alfa', 'gestor_consultoria');
  S.c1 = await createUser(S.dono, 'consultor1.alfa', 'consultor');
  S.c2 = await createUser(S.dono, 'consultor2.alfa', 'consultor');
  S.assist = await createUser(S.dono, 'assist.alfa', 'assistente_consultoria');
}, 120_000);
afterAll(async () => teardown(ctx));

const userId = async (l: string) => (await ctx.db.selectFrom('app_user').select('id').where('login', '=', l).executeTakeFirstOrThrow()).id;
let clientA: string;
let clientB: string;

describe('consulting portfolio', () => {
  it('offers the consulting functions when managing the team, and none of the hospital ones', async () => {
    const meta = (await call(S.dono, 'GET', '/users/meta')).json();
    expect(meta.assignableRoles).toEqual(expect.arrayContaining(['consultor', 'gestor_consultoria', 'assistente_consultoria', 'financeiro_consultoria']));
    expect(meta.assignableRoles).not.toContain('enf_ccih');
  });

  it('registers clients with validation; the CNPJ is unique in the portfolio', async () => {
    const bad = await call(S.assist, 'POST', '/consulting/clients', clientBody({ cnpj: '11.444.777/0001-60', email: 'sem-arroba', address: { ...address, zip: '123' } }));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().fields.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining(['cnpj', 'email', 'address.zip']));
    const ok = await call(S.assist, 'POST', '/consulting/clients', clientBody());
    expect(ok.statusCode).toBe(201);
    clientA = ok.json().id;
    expect(ok.json()).toMatchObject({ cnpj: '11444777000161', address: { zip: '13010000' }, events: [{ kind: 'cadastro' }] });
    expect((await call(S.assist, 'POST', '/consulting/clients', clientBody())).json().fields[0].path).toBe('cnpj');
    clientB = (await call(S.gestor, 'POST', '/consulting/clients', clientBody({ legalName: 'Clínica Santa Rita (teste)', tradeName: 'Clínica Santa Rita', cnpj: null, kind: 'clinica' }))).json().id;
    // The other consultancy may use the same CNPJ for its own client.
    expect((await call(S.beta, 'POST', '/consulting/clients', clientBody())).statusCode).toBe(201);
  });

  it('keeps clients away from consultants until they are assigned; the manager distributes the portfolio', async () => {
    expect((await call(S.c1, 'GET', '/consulting/clients')).json().total).toBe(0);
    expect((await call(S.c1, 'GET', `/consulting/clients/${clientA}`)).statusCode).toBe(404);
    expect((await call(S.c1, 'POST', `/consulting/clients/${clientA}/assignments`, { userId: await userId('consultor1.alfa'), role: 'responsavel', specialty: 'ccih', startsOn: null, reason: 'Início do contrato' })).statusCode).toBe(403);
    const r = await call(S.gestor, 'POST', `/consulting/clients/${clientA}/assignments`, { userId: await userId('consultor1.alfa'), role: 'responsavel', specialty: 'ccih', startsOn: null, reason: 'Início do contrato' });
    expect(r.statusCode).toBe(201);
    const list = (await call(S.c1, 'GET', '/consulting/clients')).json();
    expect(list.rows.map((c: { id: string }) => c.id)).toEqual([clientA]);
    expect(list.rows[0].responsible.name).toBe('consultor (teste)');
    expect((await call(S.c1, 'GET', `/consulting/clients/${clientB}`)).statusCode).toBe(404);
    // A consultant cannot edit the client registration nor see internal notes, but records attendances.
    const detail = (await call(S.c1, 'GET', `/consulting/clients/${clientA}`)).json();
    expect(detail).not.toHaveProperty('internalNotes');
    expect((await call(S.c1, 'PUT', `/consulting/clients/${clientA}`, clientBody({ rowVersion: detail.rowVersion }))).statusCode).toBe(403);
    const att = await call(S.c1, 'POST', `/consulting/clients/${clientA}/events`, { kind: 'atendimento', summary: 'Reunião com a CCIH do hospital', detail: 'Revisão do plano anual', occurredOn: null });
    expect(att.statusCode).toBe(201);
    expect(att.json().events[0]).toMatchObject({ kind: 'atendimento', by: 'consultor (teste)' });
    expect((await call(S.c1, 'POST', `/consulting/clients/${clientA}/events`, { kind: 'atendimento', summary: 'Futuro', detail: null, occurredOn: '2999-01-01' })).statusCode).toBe(400);
  });

  it('replaces the responsible consultant without losing history, and the replaced one loses access', async () => {
    const r = await call(S.gestor, 'POST', `/consulting/clients/${clientA}/assignments`, { userId: await userId('consultor2.alfa'), role: 'responsavel', specialty: 'ccih', startsOn: null, reason: 'Redistribuição da carteira' });
    expect(r.statusCode).toBe(201);
    const assignments = r.json().assignments;
    expect(assignments.filter((a: { endsOn: string | null }) => a.endsOn === null)).toHaveLength(1);
    const ended = assignments.find((a: { endsOn: string | null }) => a.endsOn !== null);
    expect(ended.endReason).toMatch(/Substituído por consultor \(teste\): Redistribuição/);
    expect(r.json().events.map((e: { kind: string }) => e.kind)).toContain('substituicao');
    expect((await call(S.c1, 'GET', `/consulting/clients/${clientA}`)).statusCode).toBe(404);
    expect((await call(S.c2, 'GET', `/consulting/clients/${clientA}`)).statusCode).toBe(200);
    // History cannot be rewritten in the database.
    await expect(sql`UPDATE client_assignment SET reason = 'outro' WHERE client_id = ${clientA}`.execute(ctx.db)).rejects.toThrow(/encerrar/);
    await expect(sql`DELETE FROM client_assignment WHERE client_id = ${clientA}`.execute(ctx.db)).rejects.toThrow(/não são apagadas/);
    await expect(sql`UPDATE client_event SET summary = 'x'`.execute(ctx.db)).rejects.toThrow();
  });

  it('assigns only active consultants of the same consultancy, once per client, and ends assignments with a reason', async () => {
    const hospitalUser = await userId('enf.ccih');
    expect((await call(S.gestor, 'POST', `/consulting/clients/${clientB}/assignments`, { userId: hospitalUser, role: 'apoio', specialty: null, startsOn: null, reason: 'Tentativa indevida' })).statusCode).toBe(400);
    expect((await call(S.gestor, 'POST', `/consulting/clients/${clientB}/assignments`, { userId: await userId('assist.alfa'), role: 'apoio', specialty: null, startsOn: null, reason: 'Assistente não atende' })).json().fields[0].message).toMatch(/consultores/);
    const r = await call(S.gestor, 'POST', `/consulting/clients/${clientB}/assignments`, { userId: await userId('consultor1.alfa'), role: 'apoio', specialty: 'cme', startsOn: null, reason: 'Apoio em CME' });
    expect(r.statusCode).toBe(201);
    expect((await call(S.gestor, 'POST', `/consulting/clients/${clientB}/assignments`, { userId: await userId('consultor1.alfa'), role: 'responsavel', specialty: null, startsOn: null, reason: 'Duplicado' })).statusCode).toBe(409);
    const a = r.json().assignments[0];
    expect((await call(S.gestor, 'POST', `/consulting/assignments/${a.id}/end`, { endsOn: null, reason: 'x' })).statusCode).toBe(400);
    const end = await call(S.gestor, 'POST', `/consulting/assignments/${a.id}/end`, { endsOn: null, reason: 'Fim do apoio em CME' });
    expect(end.json().assignments[0]).toMatchObject({ endReason: 'Fim do apoio em CME' });
    expect((await call(S.gestor, 'POST', `/consulting/assignments/${a.id}/end`, { endsOn: null, reason: 'De novo' })).statusCode).toBe(409);
  });

  it('manages contacts, establishments and units; internal notes only for authorized profiles', async () => {
    const c = await call(S.assist, 'POST', `/consulting/clients/${clientA}/contacts`, { kind: 'responsavel_tecnico', name: 'Dra. Ana Souza', roleTitle: 'Presidente da CCIH', registry: 'CRM-SP 123456', email: 'ana@saolucas.exemplo', phone: null, active: true, rowVersion: null });
    expect(c.statusCode).toBe(200);
    expect((await call(S.assist, 'POST', `/consulting/clients/${clientA}/contacts`, { kind: 'contato_autorizado', name: 'Sem contato', roleTitle: null, registry: null, email: null, phone: null, active: true, rowVersion: null })).statusCode).toBe(400);
    const e = await call(S.assist, 'POST', `/consulting/clients/${clientA}/establishments`, { name: 'Unidade Centro', cnes: '1234567', cnpj: null, kind: 'hospital', beds: 120, address, active: true, rowVersion: null });
    const est = e.json().establishments[0];
    expect(est).toMatchObject({ name: 'Unidade Centro', beds: 120, units: [] });
    expect((await call(S.assist, 'POST', `/consulting/clients/${clientA}/establishments`, { name: 'Ruim', cnes: '12', cnpj: null, kind: 'hospital', beds: -1, address, active: true, rowVersion: null })).statusCode).toBe(400);
    const u = await call(S.assist, 'POST', `/consulting/establishments/${est.id}/units`, { name: 'UTI Adulto 1', kind: 'uti_adulto', beds: 10, active: true, rowVersion: null });
    expect(u.json().establishments[0].units[0]).toMatchObject({ name: 'UTI Adulto 1', kind: 'uti_adulto' });
    const unit = u.json().establishments[0].units[0];
    expect((await call(S.assist, 'PUT', `/consulting/units/${unit.id}`, { name: 'UTI Adulto 1', kind: 'uti_adulto', beds: 12, active: true, rowVersion: 99 })).statusCode).toBe(409);
    // Internal notes: the assistant writes them; the responsible consultant never sees them.
    const before = (await call(S.assist, 'GET', `/consulting/clients/${clientA}`)).json();
    const upd = await call(S.assist, 'PUT', `/consulting/clients/${clientA}`, clientBody({ status: 'suspenso', internalNotes: 'Inadimplência em negociação', rowVersion: before.rowVersion }));
    expect(upd.json()).toMatchObject({ status: 'suspenso', internalNotes: 'Inadimplência em negociação' });
    expect(upd.json().events[0]).toMatchObject({ kind: 'alteracao', summary: 'Situação: ativo → suspenso.' });
    expect((await call(S.c2, 'GET', `/consulting/clients/${clientA}`)).json()).not.toHaveProperty('internalNotes');
    const log = await ctx.db.selectFrom('audit_log').select('after').where('entity', '=', 'client').where('entity_id', '=', clientA).where('action', '=', 'update').executeTakeFirstOrThrow();
    expect(JSON.stringify(log.after)).not.toContain('Inadimplência');
  });

  it('lists the team with the clients of each one, for who distributes or sees the whole portfolio', async () => {
    const team = (await call(S.gestor, 'GET', '/consulting/team')).json().members;
    expect(team.find((m: { login: string }) => m.login === 'consultor2.alfa').clients.map((c: { clientId: string }) => c.clientId)).toEqual([clientA]);
    expect((await call(S.c1, 'GET', '/consulting/team')).statusCode).toBe(403);
  });

  it('isolates consultancies and models: no access to another consultancy client nor from a hospital', async () => {
    expect((await call(S.beta, 'GET', `/consulting/clients/${clientA}`)).statusCode).toBe(404);
    expect((await call(S.beta, 'GET', '/consulting/clients')).json().rows.every((c: { id: string }) => c.id !== clientA)).toBe(true);
    expect((await call(S.beta, 'POST', `/consulting/clients/${clientA}/events`, { kind: 'observacao', summary: 'Intrusão', detail: null, occurredOn: null })).statusCode).toBe(404);
    expect((await call(S.hospital, 'GET', '/consulting/clients')).statusCode).toBe(404);
    // The database refuses portfolio rows in a hospital, and links across organizations.
    await expect(ctx.db.insertInto('client').values({ institution_id: ctx.institutionId, legal_name: 'X', kind: 'hospital', status: 'ativo', created_by_name: 'x', data_origin: 'real' }).execute()).rejects.toThrow(/exclusivo/);
    await expect(ctx.db.insertInto('client_contact').values({ institution_id: otherConsultId, client_id: clientA, kind: 'contato_autorizado', name: 'X', email: 'x@x.com' }).execute()).rejects.toThrow();
    await expect(ctx.db.insertInto('client_assignment').values({ institution_id: consultId, client_id: clientA, user_id: await userId('dono.beta'), role: 'apoio', starts_on: '2026-10-01', assigned_by_name: 'x', reason: 'x' }).execute()).rejects.toThrow();
  });

  it('sweeps every consulting route as a consultant with identifiers of a client not assigned to them', async () => {
    // clientB: no active assignment for consultor2; collect every identifier that belongs to it.
    const est = await ctx.db.selectFrom('client_establishment').select('id').where('client_id', '=', clientB).execute();
    if (!est.length) await call(S.assist, 'POST', `/consulting/clients/${clientB}/establishments`, { name: 'Sede', cnes: null, cnpj: null, kind: 'clinica', beds: null, address, active: true, rowVersion: null });
    await call(S.assist, 'POST', `/consulting/clients/${clientB}/contacts`, { kind: 'contato_autorizado', name: 'Contato B', roleTitle: null, registry: null, email: 'b@b.com', phone: null, active: true, rowVersion: null });
    const ids = [
      clientB,
      ...(await ctx.db.selectFrom('client_establishment').select('id').where('client_id', '=', clientB).execute()).map((r) => r.id),
      ...(await ctx.db.selectFrom('client_contact').select('id').where('client_id', '=', clientB).execute()).map((r) => r.id),
      ...(await ctx.db.selectFrom('client_assignment').select('id').where('client_id', '=', clientB).execute()).map((r) => r.id),
    ];
    const routes = ctx.app.routeIndex.filter((r) => r.url.startsWith('/api/consulting/') && r.url.includes(':') && r.method !== 'HEAD');
    expect(routes.length).toBeGreaterThan(8);
    const problems: string[] = [];
    for (const r of routes) {
      for (const id of ids) {
        const res = await ctx.app.inject({ method: r.method as 'GET', url: r.url.replace(/:[a-zA-Z]+/g, id), headers: S.c2.headers, ...(r.method === 'GET' ? {} : { payload: {} }) });
        if (res.statusCode < 400) problems.push(`${r.method} ${r.url} → ${res.statusCode}`);
        if (ids.some((x) => res.body.includes(x))) problems.push(`${r.method} ${r.url} devolveu identificador do cliente não atribuído`);
      }
    }
    expect(problems).toEqual([]);
    // The only write a consultant has (recording attendances) also stops at the scope, with a valid body.
    expect((await call(S.c2, 'POST', `/consulting/clients/${clientB}/events`, { kind: 'atendimento', summary: 'Fora do escopo', detail: null, occurredOn: null })).statusCode).toBe(404);
  });

  it('migration 0013 gives existing consulting organizations the new profiles (down and up)', async () => {
    // Clean the portfolio of this test database first (down drops the tables).
    const owner = ctx.owner as unknown as Kysely<unknown>;
    // 0014 (contracts) depends on the portfolio tables: undo it first and redo it after.
    await m0014.down(owner);
    await m0013.down(owner);
    await m0013.up(owner);
    await m0014.up(owner);
    const roles = (await ctx.db.selectFrom('role').select('code').where('institution_id', '=', consultId).execute()).map((r) => r.code).sort();
    expect(roles).toEqual(['admin', 'assistente_consultoria', 'consultor', 'financeiro_consultoria', 'gestor_consultoria']);
    const admin = await ctx.db.selectFrom('role').select('permissions').where('institution_id', '=', consultId).where('code', '=', 'admin').executeTakeFirstOrThrow();
    expect(admin.permissions).toEqual(expect.arrayContaining(['consultoria:clients:view', 'consultoria:portfolio:assign']));
    const hospitalRoles = (await ctx.db.selectFrom('role').select('code').where('institution_id', '=', ctx.institutionId).execute()).map((r) => r.code);
    expect(hospitalRoles).not.toContain('consultor');
  });
});
