import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createFounder } from '../src/services/founder';
import { ORIGIN, TEST_PASSWORD, accessBody, login, setupTestApp, teardown, type Session, type TestContext } from './helpers';

/**
 * Authorization by function, always by direct calls to the API (what a manual request or a forged
 * URL would do). The screen hiding a button is never what protects an action.
 */
let ctx: TestContext;
const S: Record<string, Session> = {};
const J = 'Autorização registrada em reunião da CME';

const call = (s: Session, method: string, path: string, body?: unknown) =>
  ctx.app.inject({ method: method as 'GET', url: `/api${path}`, headers: s.headers, ...(body !== undefined ? { payload: body as object } : {}) });
/** Passed authorization (the request may still fail validation with an empty body). */
const allowed = async (s: Session, method: string, path: string, body: unknown = {}) => expect((await call(s, method, path, method === 'GET' ? undefined : body)).statusCode).not.toBe(403);
const denied = async (s: Session, method: string, path: string, body: unknown = {}) => expect((await call(s, method, path, method === 'GET' ? undefined : body)).statusCode).toBe(403);
const userId = async (loginName: string) => (await ctx.db.selectFrom('app_user').select('id').where('login', '=', loginName).executeTakeFirstOrThrow()).id;
const userRow = async (loginName: string) => {
  const users = (await call(S.admin!, 'GET', '/users')).json().users as Array<{ id: string; login: string; displayName: string; rowVersion: number; sectorIds: string[]; scopeAll: boolean }>;
  return users.find((u) => u.login === loginName)!;
};
let ids: { load: string; sterilizer: string; nc: string };

beforeAll(async () => {
  ctx = await setupTestApp();
  await createFounder(ctx.db, { login: 'criador.teste', password: TEST_PASSWORD, displayName: 'Conta criadora (teste)' });
  for (const l of ['admin', 'criador.teste', 'enf.ccih', 'tec.ccih', 'cme', 'tec.cme', 'enf.qualidade', 'tec.qualidade', 'adm.cme', 'adm.ccih', 'aprendiz', 'consulta']) S[l] = await login(ctx.app, l);
  ids = {
    load: (await ctx.db.selectFrom('sterilization_load').select('id').limit(1).executeTakeFirstOrThrow()).id,
    sterilizer: (await ctx.db.selectFrom('sterilizer').select('id').limit(1).executeTakeFirstOrThrow()).id,
    nc: (await ctx.db.selectFrom('nonconformity').select('id').limit(1).executeTakeFirstOrThrow()).id,
  };
});
afterAll(async () => teardown(ctx));

const cmeWrites = () => [
  ['POST', '/cme/loads'], ['POST', `/cme/loads/${ids.load}/cycle`], ['POST', '/cme/tests'], ['POST', `/cme/loads/${ids.load}/decision`],
  ['PUT', `/cme/sterilizers/${ids.sterilizer}`], ['POST', '/cme/scan'], ['POST', '/cme/stations'],
] as const;

describe('per-function authorization (direct API calls)', () => {
  it('1–2. CCIH nurse and technician read the CME but cannot change any CME record', async () => {
    for (const who of ['enf.ccih', 'tec.ccih']) {
      await allowed(S[who]!, 'GET', '/cme/overview');
      await allowed(S[who]!, 'GET', '/cme/trace?q=AV1');
      for (const [m, p] of cmeWrites()) await denied(S[who]!, m, p);
    }
    // The technician sees what the nurse sees, but does not decide IRAS.
    const open = await ctx.db.selectFrom('iras_case').select(['id', 'row_version']).where('status', '=', 'em_investigacao').limit(1).executeTakeFirstOrThrow();
    const confirm = { to: 'confirmada', justification: J, criterionReferenceId: null, deviceAssociated: null, rowVersion: open.row_version };
    await denied(S['tec.ccih']!, 'POST', `/iras/${open.id}/status`, confirm);
  });

  it('3. CME nurse runs CME operations but has no access to the CCIH modules', async () => {
    for (const [m, p] of cmeWrites()) await allowed(S.cme!, m, p);
    for (const p of ['/patients', '/iras', '/surgeries', '/cultures', '/quality/audits']) await denied(S.cme!, 'GET', p);
    await denied(S.cme!, 'POST', '/iras');
  });

  it('4. CME technician records processes but neither releases, configures, grants exceptions nor manages indicators', async () => {
    for (const [m, p] of [['POST', '/cme/loads'], ['POST', `/cme/loads/${ids.load}/cycle`], ['POST', '/cme/tests'], ['POST', '/cme/scan']] as const) await allowed(S['tec.cme']!, m, p);
    await denied(S['tec.cme']!, 'POST', `/cme/loads/${ids.load}/decision`);
    await denied(S['tec.cme']!, 'PUT', `/cme/sterilizers/${ids.sterilizer}`);
    await denied(S['tec.cme']!, 'PUT', '/config/rules/cme.ibReadingHours', { value: 24, referenceId: null, rowVersion: 1, justification: J });
    await denied(S['tec.cme']!, 'PUT', '/config/targets/iras_ipcs');
    // An exception of sequence needs cme:override even inside the scan endpoint.
    const station = (await ctx.db.selectFrom('scan_station').select('id').where('name', '=', 'Limpeza').executeTakeFirstOrThrow()).id;
    const scan = await call(S['tec.cme']!, 'POST', '/cme/scan', { stationId: station, code: 'AT-ZZZZZZZZ', inputMethod: 'leitor', step: 'limpeza', clientEventId: null, deviceAt: null, outcome: null, destinationSectorId: null, originSectorId: null, loadId: null, packaging: null, justification: 'Exceção sem permissão', override: true });
    expect(scan.statusCode).toBe(403);
  });

  it('5–6. Quality nurse and technician audit without editing CME or source records; only the nurse conducts audits', async () => {
    for (const who of ['enf.qualidade', 'tec.qualidade']) {
      await allowed(S[who]!, 'GET', '/quality/audits');
      await allowed(S[who]!, 'GET', '/facts');
      for (const [m, p] of cmeWrites()) await denied(S[who]!, m, p);
      await denied(S[who]!, 'GET', '/cme/overview');
      await denied(S[who]!, 'GET', '/patients');
      await denied(S[who]!, 'POST', '/patients');
      await denied(S[who]!, 'PUT', '/config/targets/iras_ipcs');
      await allowed(S[who]!, 'POST', '/quality/nonconformities');
      await allowed(S[who]!, 'POST', '/bundles/audits');
    }
    await allowed(S['enf.qualidade']!, 'POST', '/quality/audits');
    await allowed(S['enf.qualidade']!, 'POST', `/quality/nonconformities/${ids.nc}/status`);
    await denied(S['tec.qualidade']!, 'POST', '/quality/audits');
    await denied(S['tec.qualidade']!, 'POST', `/quality/nonconformities/${ids.nc}/status`);
    await allowed(S['tec.qualidade']!, 'POST', '/quality/actions/00000000-0000-0000-0000-000000000000/status');
  });

  it('7. ADM CME administers the CME only: its parameters, users and log, nothing of the CCIH', async () => {
    await allowed(S['adm.cme']!, 'PUT', '/config/rules/cme.ibReadingHours', { value: 48, referenceId: null, rowVersion: 1, justification: J });
    await denied(S['adm.cme']!, 'PUT', '/config/rules/alerts.suppressHours', { value: 24, referenceId: null, rowVersion: 1, justification: J });
    await denied(S['adm.cme']!, 'GET', '/patients');
    await denied(S['adm.cme']!, 'PUT', '/config/targets/iras_ipcs');
    const log = (await call(S['adm.cme']!, 'GET', '/audit?pageSize=100')).json().rows as Array<{ entity: string; entity_id: string | null }>;
    expect(log.length).toBeGreaterThan(0);
    expect(log.some((r) => r.entity === 'rule_parameter' && r.entity_id === 'cme.ibReadingHours')).toBe(true);
    expect(log.every((r) => !['patient', 'iras_case', 'app_user', 'app_user_access'].includes(r.entity) && (r.entity !== 'rule_parameter' || r.entity_id?.startsWith('cme.')))).toBe(true);
    // Creates CME accounts, never CCIH ones or another administrator.
    const ok = await call(S['adm.cme']!, 'POST', '/users', accessBody({ login: 'tec.cme.novo', displayName: 'Técnico CME novo (teste)', functionRole: 'tec_cme', scopeAll: false, sectorIds: [await sector('cme')] }));
    expect(ok.statusCode).toBe(201);
    for (const role of ['enf_ccih', 'adm_cme', 'admin']) expect((await call(S['adm.cme']!, 'POST', '/users', accessBody({ login: `x.${role}`, functionRole: role }))).statusCode).toBe(403);
    const ccihUser = await userRow('tec.ccih');
    expect((await call(S['adm.cme']!, 'PUT', `/users/${ccihUser.id}`, accessBody({ displayName: ccihUser.displayName, functionRole: 'tec_ccih', rowVersion: ccihUser.rowVersion }))).statusCode).toBe(403);
    // Its user list shows only the CME accounts.
    const visible = (await call(S['adm.cme']!, 'GET', '/users')).json().users as Array<{ login: string }>;
    expect(visible.map((u) => u.login)).not.toContain('enf.ccih');
  });

  it('8. ADM CCIH administers the CCIH only, with no CME administration', async () => {
    await allowed(S['adm.ccih']!, 'PUT', '/config/rules/alerts.suppressHours', { value: 24, referenceId: null, rowVersion: 1, justification: J });
    await denied(S['adm.ccih']!, 'PUT', '/config/rules/cme.ibReadingHours', { value: 24, referenceId: null, rowVersion: 1, justification: J });
    for (const [m, p] of cmeWrites()) await denied(S['adm.ccih']!, m, p);
    expect((await call(S['adm.ccih']!, 'POST', '/users', accessBody({ login: 'x.tec.cme', functionRole: 'tec_cme' }))).statusCode).toBe(403);
    const cmeUser = await userRow('tec.cme');
    expect((await call(S['adm.ccih']!, 'PUT', `/users/${cmeUser.id}`, accessBody({ displayName: cmeUser.displayName, functionRole: 'tec_cme', rowVersion: cmeUser.rowVersion }))).statusCode).toBe(403);
    expect((await call(S['adm.ccih']!, 'POST', '/users', accessBody({ login: 'tec.ccih.novo', displayName: 'Técnico CCIH novo (teste)', functionRole: 'tec_ccih' }))).statusCode).toBe(201);
  });

  it('9. the apprentice reaches only what the manager granted, and only within its validity', async () => {
    const a = S.aprendiz!;
    await allowed(a, 'GET', '/cme/overview');
    await allowed(a, 'POST', '/cme/scan');
    for (const [m, p] of [['POST', '/cme/loads'], ['POST', '/cme/tests'], ['POST', `/cme/loads/${ids.load}/decision`], ['GET', '/patients'], ['GET', '/users'], ['GET', '/quality/audits']] as const) await denied(a, m, p);
    // A manager cannot give it a critical operation, and cannot activate it without grants, supervisor and expiry.
    const sup = await userId('cme');
    const base = { login: 'aprendiz.novo', displayName: 'Aprendiz novo (teste)', functionRole: 'aprendiz', scopeAll: false, sectorIds: [await sector('cme')], supervisorId: sup, validUntil: '2099-12-31' };
    expect((await call(S['adm.cme']!, 'POST', '/users', accessBody({ ...base, grants: [{ permission: 'cme:release', validUntil: null }] }))).statusCode).toBe(403);
    expect((await call(S['adm.cme']!, 'POST', '/users', accessBody({ ...base, grants: [] }))).json().fields.map((f: { path: string }) => f.path)).toContain('grants');
    const pending = await call(S['adm.cme']!, 'POST', '/users', accessBody({ ...base, grants: [], status: 'pendente' }));
    expect(pending.statusCode).toBe(201);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { login: 'aprendiz.novo', password: pending.json().temporaryPassword } })).statusCode).toBe(401);
    // Past its validity the open session ends and a new sign-in is refused.
    await ctx.db.updateTable('app_user').set({ valid_until: '2000-01-01', valid_from: '1999-01-01' }).where('login', '=', 'aprendiz').execute();
    expect((await call(a, 'GET', '/cme/overview')).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { login: 'aprendiz', password: TEST_PASSWORD } })).statusCode).toBe(401);
  });

  it('10 and 12. endpoints without permission are refused even by direct request, and every refusal is logged', async () => {
    const before = Number((await ctx.db.selectFrom('audit_log').select((eb) => eb.fn.countAll<string>().as('n')).where('action', '=', 'access_denied').executeTakeFirstOrThrow()).n);
    await denied(S.consulta!, 'GET', '/users');
    await denied(S['tec.ccih']!, 'GET', '/audit');
    await denied(S['tec.cme']!, 'POST', '/users', accessBody({ login: 'x.y', functionRole: 'tec_cme' }));
    const after = Number((await ctx.db.selectFrom('audit_log').select((eb) => eb.fn.countAll<string>().as('n')).where('action', '=', 'access_denied').executeTakeFirstOrThrow()).n);
    expect(after - before).toBeGreaterThanOrEqual(3);
  });

  it('11. revoking a permission ends the sessions and blocks new operations', async () => {
    const s = await login(ctx.app, 'tec.cme');
    await allowed(s, 'POST', '/cme/scan');
    const u = await userRow('tec.cme');
    const res = await call(S['adm.cme']!, 'PUT', `/users/${u.id}`, accessBody({ displayName: u.displayName, functionRole: 'tec_cme', scopeAll: false, sectorIds: u.sectorIds, status: 'suspenso', statusReason: 'Afastamento temporário', rowVersion: u.rowVersion }));
    expect(res.statusCode).toBe(200);
    expect((await call(s, 'POST', '/cme/scan', {})).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { login: 'tec.cme', password: TEST_PASSWORD } })).statusCode).toBe(401);
    // Reactivated with an express authorization to release loads (granted by the ADM CME, with justification).
    const again = await userRow('tec.cme');
    expect((await call(S['adm.cme']!, 'PUT', `/users/${again.id}`, accessBody({ displayName: again.displayName, functionRole: 'tec_cme', scopeAll: false, sectorIds: again.sectorIds, grants: [{ permission: 'cme:release', validUntil: '2099-12-31' }], rowVersion: again.rowVersion }))).statusCode).toBe(200);
    S['tec.cme'] = await login(ctx.app, 'tec.cme');
    await allowed(S['tec.cme']!, 'POST', `/cme/loads/${ids.load}/decision`);
    const history = (await call(S['adm.cme']!, 'GET', `/users/${again.id}/history`)).json().entries as Array<{ before: { permissions: string[] } | null; after: { permissions: string[] } | null; justification: string | null }>;
    expect(history[0]!.after!.permissions).toContain('cme:release');
    expect(history[0]!.before!.permissions).not.toContain('cme:release');
    expect(history[0]!.justification).toBeTruthy();
  });

  it('13. nobody raises their own access; only the creator account creates or changes system administrators', async () => {
    const self = await userRow('adm.cme');
    expect((await call(S['adm.cme']!, 'PUT', `/users/${self.id}`, accessBody({ displayName: self.displayName, functionRole: 'adm_cme', extraRoles: ['adm_ccih'], rowVersion: self.rowVersion }))).statusCode).toBe(403);
    // A module administrator cannot grant administration either.
    const tec = await userRow('tec.cme');
    expect((await call(S['adm.cme']!, 'PUT', `/users/${tec.id}`, accessBody({ displayName: tec.displayName, functionRole: 'tec_cme', grants: [{ permission: 'users:manage:cme', validUntil: null }], rowVersion: tec.rowVersion }))).statusCode).toBe(403);
    // A system administrator cannot create another one; the creator account can.
    expect((await call(S.admin!, 'POST', '/users', accessBody({ login: 'outro.admin', functionRole: 'admin' }))).statusCode).toBe(403);
    const created = await call(S['criador.teste']!, 'POST', '/users', accessBody({ login: 'novo.admin', displayName: 'Novo administrador (teste)', functionRole: 'admin' }));
    expect(created.statusCode).toBe(201);
    const newAdmin = await userRow('novo.admin');
    expect((await call(S.admin!, 'PUT', `/users/${newAdmin.id}`, accessBody({ displayName: newAdmin.displayName, functionRole: 'consulta', rowVersion: newAdmin.rowVersion }))).statusCode).toBe(403);
    // Nobody changes the creator account, and the database refuses to demote it.
    const founder = await userRow('criador.teste');
    expect((await call(S.admin!, 'PUT', `/users/${founder.id}`, accessBody({ displayName: founder.displayName, functionRole: 'consulta', rowVersion: founder.rowVersion }))).statusCode).toBe(403);
    expect((await call(S.admin!, 'POST', `/users/${founder.id}/reset-password`, { justification: 'Tentativa de redefinição' })).statusCode).toBe(403);
    await expect(sql`UPDATE app_user SET is_founder = false WHERE login = 'criador.teste'`.execute(ctx.owner)).rejects.toThrow(/criadora/);
    await expect(sql`DELETE FROM user_role WHERE user_id = ${founder.id}`.execute(ctx.owner)).rejects.toThrow(/criadora/);
    await expect(createFounder(ctx.db, { login: 'segundo.criador', password: TEST_PASSWORD, displayName: 'Outro criador' })).rejects.toThrow(/já tem uma conta criadora/);
  });

  it('14. critical operations keep their approval flow: a released decision still needs the release permission and the policy', async () => {
    await denied(S.cme!, 'PUT', '/config/load-release-policy');
    await denied(S['enf.ccih']!, 'POST', `/cme/loads/${ids.load}/decision`, { status: 'liberada', justification: J, rowVersion: 1 });
    await denied(S['tec.qualidade']!, 'POST', `/quality/nonconformities/${ids.nc}/status`, { to: 'encerrada', effectiveness: 'x', justification: J, rowVersion: 1 });
  });
});

async function sector(code: string) {
  return (await ctx.db.selectFrom('sector').select('id').where('code', '=', code).executeTakeFirstOrThrow()).id;
}
