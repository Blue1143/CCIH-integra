import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { buildApp, type AppOptions } from '../src/app';
import { createDb } from '../src/db/client';
import { grantAppRole, migrateToLatest, resetSchema } from '../src/db/migrate';
import { seedDemo } from '../src/db/seed';
import type { DB } from '../src/db/types';
import { loadEnv, type Env } from '../src/env';

/** Random per run: no fixed password lives in the repository. */
export const TEST_PASSWORD = `Teste-${randomBytes(9).toString('base64url')}-Aa1!`;
export const ORIGIN = 'http://localhost:5173';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export interface TestContext {
  app: FastifyInstance;
  db: Kysely<DB>;
  owner: Kysely<DB>;
  env: Env;
  institutionId: string;
}

/** Fresh schema + synthetic seed in the dedicated test database. */
export async function setupTestApp(overrides: Record<string, string> = {}, appOptions: Partial<Pick<AppOptions, 'realtimeHeartbeatMs' | 'vault' | 'scanner'>> = {}): Promise<TestContext> {
  const appUrl = process.env.TEST_DATABASE_URL;
  const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;
  if (!appUrl || !ownerUrl) throw new Error('Defina TEST_DATABASE_URL e TEST_DATABASE_OWNER_URL (veja apps/api/.env.example).');
  const owner = createDb(ownerUrl, 1);
  await resetSchema(owner);
  await migrateToLatest(owner);
  await grantAppRole(owner, new URL(appUrl).username);
  const db = createDb(appUrl, 4);
  const { institutionId } = await seedDemo(db, { password: TEST_PASSWORD });
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: appUrl, APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', LOGIN_MAX_ATTEMPTS: '3', SESSION_IDLE_MINUTES: '30', LOGIN_RATE_LIMIT_PER_MINUTE: '200', ...overrides });
  const app = await buildApp({ db, env, logger: false, ...appOptions });
  return { app, db, owner, env, institutionId };
}

export async function teardown(ctx: TestContext) {
  await ctx.app.close();
  await ctx.db.destroy();
  await ctx.owner.destroy();
}

export interface Session {
  cookie: string;
  csrf: string;
  headers: Record<string, string>;
}

export async function login(app: FastifyInstance, login: string, password = TEST_PASSWORD): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { login, password } });
  if (res.statusCode !== 200) throw new Error(`login ${login} falhou: ${res.statusCode} ${res.body}`);
  const cookies = res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const csrf = res.json<{ csrfToken: string }>().csrfToken;
  return { cookie: cookies, csrf, headers: { cookie: cookies, 'x-csrf-token': csrf, origin: ORIGIN } };
}

/** Body of a user access change (creation adds the login); tests override what they exercise. */
export function accessBody(over: Record<string, unknown> = {}) {
  return {
    displayName: 'Usuário de teste', email: null, registration: null, category: null, functionRole: 'consulta', extraRoles: [], scopeAll: true, sectorIds: [],
    status: 'ativo', statusReason: null, validFrom: null, validUntil: null, supervisorId: null, grants: [], justification: 'Ajuste aprovado em reunião da CCIH', ...over,
  };
}
