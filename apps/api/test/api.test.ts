import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { DEFAULT_ROLE_PERMISSIONS } from '@ccih/domain';
import { verifyAuditChain } from '../src/audit/audit';
import { ORIGIN, TEST_PASSWORD, login, setupTestApp, teardown, type TestContext, accessBody } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestApp();
});
afterAll(async () => teardown(ctx));

const lastAudit = async (action: string) =>
  ctx.db.selectFrom('audit_log').selectAll().where('action', '=', action).orderBy('id', 'desc').limit(1).executeTakeFirst();

describe('health and anonymous access', () => {
  it('answers health without authentication', async () => {
    expect((await ctx.app.inject('/api/health')).json()).toEqual({ status: 'ok' });
  });

  it('answers the session probe without a 401 for anonymous visitors', async () => {
    expect((await ctx.app.inject('/api/auth/me')).json()).toEqual({ authenticated: false });
  });

  it('requires a session for data', async () => {
    const res = await ctx.app.inject('/api/institution');
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toMatch(/Entre novamente/);
  });

  it('sets security headers and no-store', async () => {
    const res = await ctx.app.inject('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });
});

describe('authentication', () => {
  it('logs in with HttpOnly, SameSite=Strict cookies and returns permissions', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { login: 'enf.ccih', password: TEST_PASSWORD } });
    const session = res.cookies.find((c) => c.name === 'ccih_session')!;
    expect(session.httpOnly).toBe(true);
    expect(session.sameSite).toBe('Strict');
    const s = await login(ctx.app, 'enf.ccih');
    const me = (await ctx.app.inject({ url: '/api/auth/me', headers: s.headers })).json();
    expect(me.permissions).toEqual(expect.arrayContaining(DEFAULT_ROLE_PERMISSIONS.enf_ccih));
    expect(me.scope).toBeNull();
    expect(me.user).not.toHaveProperty('password_hash');
  });

  it('answers unknown logins and wrong passwords with the same generic message', async () => {
    const a = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { login: 'nao.existe', password: 'x' } });
    const b = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { login: 'gestor', password: 'errada' } });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json().message).toBe(b.json().message);
  });

  it('locks the account after the configured attempts and the admin can unlock it', async () => {
    for (let i = 0; i < 3; i++) await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { login: 'auditor', password: 'errada' } });
    const blocked = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { login: 'auditor', password: TEST_PASSWORD } });
    expect(blocked.statusCode).toBe(401);
    expect((await lastAudit('login_failure'))?.context).toMatchObject({ reason: 'bloqueado' });
    const admin = await login(ctx.app, 'admin');
    const auditor = await ctx.db.selectFrom('app_user').select('id').where('login', '=', 'auditor').executeTakeFirstOrThrow();
    expect((await ctx.app.inject({ method: 'POST', url: `/api/users/${auditor.id}/unlock`, headers: admin.headers })).statusCode).toBe(200);
    await expect(login(ctx.app, 'auditor')).resolves.toBeDefined();
  });

  it('never stores the password or its hash in the audit log', async () => {
    const rows = await ctx.db.selectFrom('audit_log').select(['before', 'after', 'context']).execute();
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(TEST_PASSWORD);
    expect(dump).not.toMatch(/argon2|password/);
  });

  it('expires idle sessions on the server and records it', async () => {
    const s = await login(ctx.app, 'gestor');
    await ctx.db.updateTable('session').set({ last_seen_at: new Date(Date.now() - 31 * 60_000) }).where('revoked_at', 'is', null).where('user_id', '=', ctx.db.selectFrom('app_user').select('id').where('login', '=', 'gestor')).execute();
    expect((await ctx.app.inject({ url: '/api/auth/me', headers: s.headers })).json()).toEqual({ authenticated: false });
    expect((await lastAudit('session_expired'))?.context).toMatchObject({ reason: 'inatividade' });
  });

  it('revokes the session on logout', async () => {
    const s = await login(ctx.app, 'consulta');
    expect((await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: s.headers })).statusCode).toBe(200);
    expect((await ctx.app.inject({ url: '/api/auth/me', headers: s.headers })).json()).toEqual({ authenticated: false });
  });
});

describe('CSRF and origin', () => {
  it('rejects state changes without the CSRF token or from another origin', async () => {
    const s = await login(ctx.app, 'admin');
    const body = { value: 1.8, warningBand: 0.4, referenceId: null, rowVersion: 1, justification: 'Ajuste aprovado em reunião da CCIH' };
    const noToken = await ctx.app.inject({ method: 'PUT', url: '/api/config/targets/di-ipcs', headers: { cookie: s.cookie, origin: ORIGIN }, payload: body });
    expect(noToken.statusCode).toBe(403);
    expect(noToken.json().error).toBe('csrf');
    const otherOrigin = await ctx.app.inject({ method: 'PUT', url: '/api/config/targets/di-ipcs', headers: { ...s.headers, origin: 'https://atacante.example' }, payload: body });
    expect(otherOrigin.json().error).toBe('origem');
  });
});

describe('authorization (RBAC on the server)', () => {
  it('denies and audits actions outside the profile', async () => {
    const gestor = await login(ctx.app, 'gestor');
    const res = await ctx.app.inject({ method: 'PUT', url: '/api/config/targets/di-ipcs', headers: gestor.headers, payload: { value: 1, warningBand: null, referenceId: null, rowVersion: 1, justification: 'Ajuste aprovado em reunião da CCIH' } });
    expect(res.statusCode).toBe(403);
    expect(await lastAudit('access_denied')).toMatchObject({ user_login: 'gestor' });
  });

  it('keeps the CME profile out of IRAS indicators', async () => {
    const cme = await login(ctx.app, 'cme');
    expect((await ctx.app.inject({ url: '/api/facts?from=2026-01-01&to=2026-09-01', headers: cme.headers })).statusCode).toBe(403);
  });
});

describe('sector scope (anti-IDOR)', () => {
  it('returns only the sectors and facts within the user scope', async () => {
    const s = await login(ctx.app, 'consulta');
    const inst = (await ctx.app.inject({ url: '/api/institution', headers: s.headers })).json();
    expect(inst.data.sectors.map((x: { code: string }) => x.code).sort()).toEqual(['clinica-cirurgica', 'uti-coronariana']);
    const allowed = new Set(inst.data.sectors.map((x: { id: string }) => x.id));
    const facts = (await ctx.app.inject({ url: '/api/facts?from=2024-01-01&to=2030-12-01', headers: s.headers })).json();
    expect(facts.data.rows.length).toBeGreaterThan(0);
    for (const r of facts.data.rows) expect(allowed.has(r.sectorId)).toBe(true);
    expect(facts.provenance.origin).toBe('demo');
  });

  it('validates query parameters', async () => {
    const s = await login(ctx.app, 'gestor');
    const res = await ctx.app.inject({ url: '/api/facts?from=2026-01-15&to=2026-09-01', headers: s.headers });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields[0].message).toMatch(/primeiro dia do mês/);
  });
});

describe('configuration', () => {
  it('turns a demo target into an institutional one, audited with before/after and optimistic locking', async () => {
    const s = await login(ctx.app, 'admin');
    const ok = await ctx.app.inject({ method: 'PUT', url: '/api/config/targets/di-ipcs', headers: s.headers, payload: { value: 1.8, warningBand: 0.4, referenceId: null, rowVersion: 1, justification: 'Ajuste aprovado em reunião da CCIH' } });
    expect(ok.json()).toEqual({ ok: true, rowVersion: 2 });
    const inst = (await ctx.app.inject({ url: '/api/institution', headers: s.headers })).json();
    expect(inst.data.config.targets.find((t: { indicatorId: string }) => t.indicatorId === 'di-ipcs')).toMatchObject({ value: 1.8, origin: 'institucional', approvedBy: 'Administrador (demonstração)', direction: 'lower' });
    const entry = await lastAudit('update');
    expect(entry).toMatchObject({ entity: 'indicator_target', entity_id: 'di-ipcs', user_login: 'admin' });
    expect(entry?.before).toMatchObject({ value: 2, origin: 'demonstracao' });
    expect(entry?.after).toMatchObject({ value: 1.8, origin: 'institucional' });
    expect(entry?.context).toMatchObject({ justification: 'Ajuste aprovado em reunião da CCIH' });
    const noReason = await ctx.app.inject({ method: 'PUT', url: '/api/config/targets/di-ipcs', headers: s.headers, payload: { value: 1.5, warningBand: null, referenceId: null, rowVersion: 2, justification: 'curto' } });
    expect(noReason.json().fields[0]).toMatchObject({ path: 'justification', message: 'Descreva o motivo (mínimo 10 caracteres).' });
    const stale = await ctx.app.inject({ method: 'PUT', url: '/api/config/targets/di-ipcs', headers: s.headers, payload: { value: 1.5, warningBand: null, referenceId: null, rowVersion: 1, justification: 'Ajuste aprovado em reunião da CCIH' } });
    expect(stale.statusCode).toBe(409);
  });

  it('rejects unknown fields (no mass assignment)', async () => {
    const s = await login(ctx.app, 'admin');
    const res = await ctx.app.inject({ method: 'PUT', url: '/api/config/targets/di-pav', headers: s.headers, payload: { value: 6, warningBand: null, referenceId: null, rowVersion: 1, justification: 'Ajuste aprovado em reunião da CCIH', origin: 'demonstracao', approved_by: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields[0].message).toMatch(/não permitido/);
  });

  it('validates rule parameters with pt-BR messages', async () => {
    const s = await login(ctx.app, 'admin');
    const bad = await ctx.app.inject({ method: 'PUT', url: '/api/config/rules/surgery.prophylaxisWindowMin', headers: s.headers, payload: { value: 0, referenceId: null, rowVersion: 1, justification: 'Ajuste aprovado em reunião da CCIH' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().fields[0].message).toMatch(/entre 1 e 240/);
    const good = await ctx.app.inject({ method: 'PUT', url: '/api/config/rules/surgery.prophylaxisWindowMin', headers: s.headers, payload: { value: 45, referenceId: null, rowVersion: 1, justification: 'Ajuste aprovado em reunião da CCIH' } });
    expect(good.statusCode).toBe(200);
  });

  it('validates references by a clinical profile and resets validation when the content changes', async () => {
    const versions = async (h: Record<string, string>) => (await ctx.app.inject({ url: '/api/config/versions', headers: h })).json();
    const infecto = await login(ctx.app, 'infecto');
    const ref = (await versions(infecto.headers)).references.find((r: { code: string }) => r.code === 'ref-protocolo-isc');
    const v = await ctx.app.inject({ method: 'POST', url: `/api/config/references/${ref.id}/validate`, headers: infecto.headers, payload: { status: 'vigente', rowVersion: ref.row_version, justification: 'Ajuste aprovado em reunião da CCIH' } });
    expect(v.statusCode).toBe(200);
    const admin = await login(ctx.app, 'admin');
    let inst = (await ctx.app.inject({ url: '/api/institution', headers: admin.headers })).json();
    expect(inst.data.references.find((r: { id: string }) => r.id === ref.id)).toMatchObject({ status: 'vigente', validatedBy: 'Infectologista (demonstração)' });
    const edit = await ctx.app.inject({
      method: 'PUT', url: `/api/config/references/${ref.id}`, headers: admin.headers,
      payload: { title: 'Protocolo de vigilância de ISC', kind: 'protocolo_institucional', source: 'Protocolo da instituição', version: '2.0', updatedAt: '2026-10-09', notes: null, rowVersion: v.json().rowVersion, justification: 'Ajuste aprovado em reunião da CCIH' },
    });
    expect(edit.statusCode).toBe(200);
    inst = (await ctx.app.inject({ url: '/api/institution', headers: admin.headers })).json();
    expect(inst.data.references.find((r: { id: string }) => r.id === ref.id)).toMatchObject({ status: 'revisao_necessaria', validatedBy: null, version: '2.0' });
  });

  it('refuses a reference from another tenant or that does not exist', async () => {
    const s = await login(ctx.app, 'admin');
    const res = await ctx.app.inject({ method: 'PUT', url: '/api/config/targets/di-itu', headers: s.headers, payload: { value: 2, warningBand: null, referenceId: '00000000-0000-4000-8000-000000000000', rowVersion: 1, justification: 'Ajuste aprovado em reunião da CCIH' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('users and profiles', () => {
  it('changes access, ends the user sessions and blocks self-lockout', async () => {
    const admin = await login(ctx.app, 'admin');
    const consulta = await login(ctx.app, 'consulta');
    const users = (await ctx.app.inject({ url: '/api/users', headers: admin.headers })).json().users;
    const target = users.find((u: { login: string }) => u.login === 'consulta');
    const res = await ctx.app.inject({ method: 'PUT', url: `/api/users/${target.id}`, headers: admin.headers, payload: accessBody({ displayName: target.displayName, functionRole: 'consulta', extraRoles: ['gestor'], rowVersion: target.rowVersion }) });
    expect(res.statusCode).toBe(200);
    expect((await ctx.app.inject({ url: '/api/institution', headers: consulta.headers })).statusCode).toBe(401);
    const self = users.find((u: { login: string }) => u.login === 'admin');
    // Nobody changes their own access, not even an administrator.
    const lock = await ctx.app.inject({ method: 'PUT', url: `/api/users/${self.id}`, headers: admin.headers, payload: accessBody({ displayName: self.displayName, functionRole: 'admin', rowVersion: self.rowVersion }) });
    expect(lock.statusCode).toBe(403);
  });
});

describe('audit log', () => {
  it('is readable by auditors with pagination and the hash chain is intact', async () => {
    const auditor = await login(ctx.app, 'auditor');
    const page = (await ctx.app.inject({ url: '/api/audit?pageSize=10', headers: auditor.headers })).json();
    expect(page.rows).toHaveLength(10);
    expect(page.total).toBeGreaterThan(10);
    expect((await ctx.app.inject({ url: '/api/audit/verify', headers: auditor.headers })).json()).toMatchObject({ ok: true });
  });

  it('cannot be changed by the application role, and tampering is detected', async () => {
    await expect(sql`UPDATE audit_log SET action = 'x'`.execute(ctx.db)).rejects.toThrow(/permission denied/);
    await expect(sql`DELETE FROM audit_log`.execute(ctx.db)).rejects.toThrow(/permission denied/);
    await expect(sql`UPDATE audit_log SET action = 'x'`.execute(ctx.owner)).rejects.toThrow(/somente inserção/);
    // Simulate a privileged tamper by bypassing the trigger, then detect it.
    await sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete`.execute(ctx.owner);
    await sql`UPDATE audit_log SET user_login = 'outro' WHERE id = (SELECT min(id) FROM audit_log)`.execute(ctx.owner);
    await sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update_delete`.execute(ctx.owner);
    expect((await verifyAuditChain(ctx.db)).ok).toBe(false);
  });
});
