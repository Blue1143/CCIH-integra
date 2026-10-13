import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { seedDemo } from '../src/db/seed';
import { ORIGIN, TEST_PASSWORD, login, setupTestApp, teardown, type Session, type TestContext } from './helpers';

/**
 * Isolation between organizations, swept over EVERY registered route (not a hand-kept list): a
 * user of organization A calls each route with identifiers that belong to organization B. Nothing
 * of B may come back in any response, and nothing of B may change or be linked to A.
 */
let ctx: TestContext;
let A: Session;
let instB: string;
/** Identifiers created by organization B's synthetic data, by table. */
const idsOfB = new Map<string, string[]>();
const allB = new Set<string>();
let tables: string[];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const leaked = (text: string) => [...new Set(text.match(UUID) ?? [])].filter((u) => allB.has(u));

async function idsByTable(): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const t of tables) {
    const rows = await sql<{ id: string }>`SELECT id::text AS id FROM ${sql.table(t)}`.execute(ctx.owner);
    out.set(t, new Set(rows.rows.map((r) => r.id)));
  }
  return out;
}

/** Every row of every table, as text (to detect any change touching organization B). */
async function snapshot(): Promise<Map<string, Set<string>>> {
  const all = (await sql<{ table_name: string }>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name NOT LIKE 'kysely_%'`.execute(ctx.owner)).rows.map((r) => r.table_name);
  const out = new Map<string, Set<string>>();
  for (const t of all) out.set(t, new Set((await sql<{ r: string }>`SELECT t::text AS r FROM ${sql.table(t)} t`.execute(ctx.owner)).rows.map((x) => x.r)));
  return out;
}

beforeAll(async () => {
  ctx = await setupTestApp({ API_RATE_LIMIT_PER_MINUTE: '100000' });
  tables = (await sql<{ table_name: string }>`
    SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
    WHERE c.table_schema = 'public' AND c.column_name = 'id' AND t.table_type = 'BASE TABLE' AND c.data_type = 'uuid' ORDER BY 1`.execute(ctx.owner)).rows.map((r) => r.table_name);
  const before = await idsByTable();
  const b = await seedDemo(ctx.db, { password: TEST_PASSWORD, additional: { loginPrefix: 'hb.', name: 'Hospital B (teste de isolamento)' } });
  instB = b.institutionId;
  const after = await idsByTable();
  for (const t of tables) {
    const fresh = [...after.get(t)!].filter((id) => !before.get(t)!.has(id));
    idsOfB.set(t, fresh);
    for (const id of fresh) allB.add(id);
  }
  A = await login(ctx.app, 'admin');
}, 120_000);
afterAll(async () => teardown(ctx));

/** Routes that end the caller's session or stream forever are not part of the sweep. */
const SKIP = new Set(['/api/events', '/api/auth/logout', '/api/auth/login', '/api/auth/password', '/api/health']);

describe('isolation between organizations (sweep of every route)', () => {
  it('organization B exists with its own data and users', async () => {
    expect(allB.has(instB)).toBe(true);
    expect(idsOfB.get('patient')!.length).toBeGreaterThan(0);
    expect(idsOfB.get('sterilization_load')!.length).toBeGreaterThan(0);
    const b = await login(ctx.app, 'hb.admin');
    const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: b.headers });
    expect(me.json().user.login).toBe('hb.admin');
    // Control: the detector does see B's identifiers when B reads its own record (so an empty result below is meaningful).
    const own = await ctx.app.inject({ method: 'GET', url: `/api/patients/${idsOfB.get('patient')![0]}`, headers: b.headers });
    expect(own.statusCode).toBe(200);
    expect(leaked(own.body).length).toBeGreaterThan(0);
  });

  it('returns nothing of B and changes nothing of B through any route, with B identifiers in the path or the query', async () => {
    const routes = ctx.app.routeIndex.filter((r) => r.url.startsWith('/api/') && !SKIP.has(r.url) && r.method !== 'HEAD' && r.method !== 'OPTIONS');
    expect(routes.length).toBeGreaterThan(120);
    // One identifier of B per table is enough to exercise every lookup (the code path does not depend on which row).
    const candidates = [...idsOfB.entries()].filter(([, ids]) => ids.length).map(([t, ids]) => ({ table: t, id: ids[0]! }));
    const queryKeys: Record<string, string> = {
      sectorId: 'sector', unitId: 'unit', patientId: 'patient', admissionId: 'admission', loadId: 'sterilization_load', stationId: 'scan_station', setId: 'instrument_set',
      sterilizerId: 'sterilizer', trainingId: 'training', supplyId: 'supply', auditId: 'quality_audit', entityId: 'sterilization_test', surgeryId: 'surgery', userId: 'app_user', templateId: 'bundle_template',
    };
    const before = await snapshot();
    const problems: string[] = [];
    let calls = 0;
    const send = async (method: string, url: string) => {
      calls++;
      const res = await ctx.app.inject({ method: method as 'GET', url, headers: { ...A.headers, origin: ORIGIN }, ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }) });
      const found = leaked(res.body);
      if (found.length) problems.push(`${method} ${url} → ${res.statusCode} devolveu dados de B (${found.length})`);
      if (method === 'GET' && res.statusCode < 300 && /:[a-zA-Z]+/.test(url)) problems.push(`${method} ${url} → ${res.statusCode} com identificador de B`);
    };
    for (const r of routes) {
      if (r.url.includes(':')) {
        for (const c of candidates) await send(r.method, r.url.replace(/:[a-zA-Z]+/g, c.id));
      } else {
        await send(r.method, r.url);
        if (r.method === 'GET') {
          for (const [key, table] of Object.entries(queryKeys)) {
            const id = idsOfB.get(table)?.[0];
            if (id) await send('GET', `${r.url}?${key}=${id}`);
          }
        }
      }
    }
    const after = await snapshot();
    for (const [t, rows] of before) {
      const now = after.get(t)!;
      for (const row of rows) if (!now.has(row) && (row.includes(instB) || leaked(row).length)) problems.push(`linha de B alterada ou apagada em ${t}`);
      if (t === 'audit_log' || t === 'session' || t === 'event_outbox') continue;
      for (const row of now) if (!rows.has(row) && leaked(row).length) problems.push(`linha nova em ${t} referencia B`);
    }
    expect(calls).toBeGreaterThan(4000);
    expect(problems).toEqual([]);
  }, 600_000);
});
