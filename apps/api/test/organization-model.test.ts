import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { DEFAULT_ROLE_PERMISSIONS, MODEL_PERMISSIONS, effectivePermissions } from '@ccih/domain';
import { createOrganization } from '../src/services/organization';
import { TEST_PASSWORD, accessBody, login, setupTestApp, teardown, type Session, type TestContext } from './helpers';

/** Two business models on one platform: the model is enforced by the API, not by the menu. */
let ctx: TestContext;
let hospital: Session;
let consult: Session;
let consultId: string;
const call = (s: Session, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) =>
  ctx.app.inject({ method, url: `/api${path}`, headers: s.headers, ...(body !== undefined ? { payload: body as object } : {}) });

beforeAll(async () => {
  ctx = await setupTestApp();
  const r = await createOrganization(ctx.db, { type: 'consultoria', name: 'Consultoria Exemplo (teste)', cnpj: '11.222.333/0001-81', founder: { login: 'dono.consultoria', password: TEST_PASSWORD, displayName: 'Responsável da consultoria' } });
  consultId = r.institutionId;
  hospital = await login(ctx.app, 'admin');
  consult = await login(ctx.app, 'dono.consultoria');
});
afterAll(async () => teardown(ctx));

describe('organization model', () => {
  it('keeps every existing organization as a hospital, with exactly the permissions it had', async () => {
    const inst = await ctx.db.selectFrom('institution').select('organization_type').where('id', '=', ctx.institutionId).executeTakeFirstOrThrow();
    expect(inst.organization_type).toBe('hospitalar');
    const me = (await call(hospital, 'GET', '/auth/me')).json();
    expect(me.organization).toEqual({ type: 'hospitalar', name: expect.any(String) });
    expect([...me.permissions].sort()).toEqual([...new Set(effectivePermissions(DEFAULT_ROLE_PERMISSIONS.admin, 'hospitalar'))].sort());
    expect(me.permissions.some((p: string) => p.startsWith('consultoria:'))).toBe(false);
  });

  it('creates a consulting organization with its model persisted across logins', async () => {
    const row = await ctx.db.selectFrom('institution').select(['organization_type', 'cnpj', 'data_origin']).where('id', '=', consultId).executeTakeFirstOrThrow();
    expect(row).toEqual({ organization_type: 'consultoria', cnpj: '11222333000181', data_origin: 'real' });
    const again = await login(ctx.app, 'dono.consultoria');
    expect((await call(again, 'GET', '/auth/me')).json().organization.type).toBe('consultoria');
    // Only the profiles of its model exist in the organization.
    expect((await ctx.db.selectFrom('role').select('code').where('institution_id', '=', consultId).execute()).map((r) => r.code).sort()).toEqual(['admin', 'assistente_consultoria', 'consultor', 'financeiro_consultoria', 'gestor_consultoria']);
  });

  it('refuses invalid or duplicated CNPJ and a taken login, writing nothing', async () => {
    const before = (await ctx.db.selectFrom('institution').select('id').execute()).length;
    await expect(createOrganization(ctx.db, { type: 'hospitalar', name: 'Outro', cnpj: '11.222.333/0001-80', founder: { login: 'x.novo', password: TEST_PASSWORD, displayName: 'Fulano' } })).rejects.toThrow(/CNPJ/);
    await expect(createOrganization(ctx.db, { type: 'hospitalar', name: 'Outro', cnpj: '11222333000181', founder: { login: 'x.novo', password: TEST_PASSWORD, displayName: 'Fulano' } })).rejects.toThrow(/Já existe/);
    await expect(createOrganization(ctx.db, { type: 'hospitalar', name: 'Outro', founder: { login: 'admin', password: TEST_PASSWORD, displayName: 'Fulano' } })).rejects.toThrow(/login/);
    await expect(createOrganization(ctx.db, { type: 'hospitalar', name: 'Outro', founder: { login: 'x.novo', password: 'curta', displayName: 'Fulano' } })).rejects.toThrow(/curta/);
    expect((await ctx.db.selectFrom('institution').select('id').execute()).length).toBe(before);
  });

  it('gives the consulting organization no hospital module, even by direct call', async () => {
    const me = (await call(consult, 'GET', '/auth/me')).json();
    expect(me.permissions.every((p: string) => MODEL_PERMISSIONS.consultoria.includes(p as never))).toBe(true);
    expect(me.permissions).toContain('users:manage');
    for (const path of ['/patients', '/iras', '/cme/overview', '/quality/audits', '/config/rules', '/org/units', '/cme/labels', '/surgeries', '/trainings']) {
      expect((await call(consult, 'GET', path)).statusCode).toBe(404);
    }
    expect((await call(consult, 'POST', '/cme/loads', {})).statusCode).toBe(404);
    const denied = await ctx.db.selectFrom('audit_log').select('context').where('institution_id', '=', consultId).where('action', '=', 'access_denied').execute();
    expect(denied.length).toBeGreaterThan(0);
    // Shared modules keep working.
    for (const path of ['/users', '/alerts', '/me/notifications', '/audit']) expect((await call(consult, 'GET', path)).statusCode).toBe(200);
  });

  it('never lets a permission of the other model take effect, even if a profile or grant carries it', async () => {
    // Misconfiguration on purpose: a hospital profile row inside the consultancy, assigned to a user.
    await ctx.db.insertInto('role').values({ institution_id: consultId, code: 'enf_ccih', name: 'Enfermeiro CCIH', permissions: DEFAULT_ROLE_PERMISSIONS.enf_ccih, module: 'ccih' }).execute();
    const founder = await ctx.db.selectFrom('app_user').select('id').where('login', '=', 'dono.consultoria').executeTakeFirstOrThrow();
    await ctx.db.insertInto('user_role').values({ user_id: founder.id, institution_id: consultId, role_code: 'enf_ccih' }).execute();
    await ctx.db.insertInto('user_permission').values({ user_id: founder.id, permission: 'cme:view', granted_by: null, granted_by_name: 'teste', justification: 'Concessão indevida (teste)', valid_until: null }).execute();
    const s = await login(ctx.app, 'dono.consultoria');
    const me = (await call(s, 'GET', '/auth/me')).json();
    expect(me.permissions).not.toContain('iras:view');
    expect(me.permissions).not.toContain('cme:view');
    expect((await call(s, 'GET', '/iras')).statusCode).toBe(404);
    await ctx.db.deleteFrom('user_role').where('user_id', '=', founder.id).where('role_code', '=', 'enf_ccih').execute();
    await ctx.db.deleteFrom('role').where('institution_id', '=', consultId).where('code', '=', 'enf_ccih').execute();
  });

  it('offers and accepts only profiles of the organization model when managing users', async () => {
    const meta = (await call(consult, 'GET', '/users/meta')).json();
    expect(meta.assignableRoles).toEqual(['admin', 'gestor_consultoria', 'consultor', 'assistente_consultoria', 'financeiro_consultoria']);
    const res = await call(consult, 'POST', '/users', { ...accessBody({ functionRole: 'enf_ccih' }), login: 'enf.na.consultoria', displayName: 'Enfermeira (teste)' });
    expect([400, 403]).toContain(res.statusCode);
    const hospitalMeta = (await call(hospital, 'GET', '/users/meta')).json();
    expect(hospitalMeta.assignableRoles).toContain('enf_ccih');
  });

  it('protects the model in the database: the application cannot change it; profiles and scopes cannot cross organizations', async () => {
    await expect(sql`UPDATE institution SET organization_type = 'hospitalar' WHERE id = ${consultId}`.execute(ctx.db)).rejects.toThrow(/comando administrativo/);
    await sql`UPDATE institution SET name = 'Consultoria Exemplo (renomeada)' WHERE id = ${consultId}`.execute(ctx.db);
    const hospitalUser = await ctx.db.selectFrom('app_user').select('id').where('login', '=', 'enf.ccih').executeTakeFirstOrThrow();
    await expect(ctx.db.insertInto('user_role').values({ user_id: hospitalUser.id, institution_id: consultId, role_code: 'admin' }).execute()).rejects.toThrow();
    const consultUser = await ctx.db.selectFrom('app_user').select('id').where('login', '=', 'dono.consultoria').executeTakeFirstOrThrow();
    const sector = await ctx.db.selectFrom('sector').select('id').where('institution_id', '=', ctx.institutionId).limit(1).executeTakeFirstOrThrow();
    await expect(ctx.db.insertInto('user_scope').values({ user_id: consultUser.id, sector_id: sector.id }).execute()).rejects.toThrow(/outra organização/);
    // The administrative conversion (database owner) is possible and keeps the data.
    await sql`UPDATE institution SET organization_type = 'hospitalar' WHERE id = ${consultId}`.execute(ctx.owner);
    await sql`UPDATE institution SET organization_type = 'consultoria' WHERE id = ${consultId}`.execute(ctx.owner);
  });
});
