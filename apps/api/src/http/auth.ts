import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { effectivePermissions, isPermission, todayIn, type OrganizationType, type Permission } from '@ccih/domain';
import type { DB } from '../db/types';
import type { Env } from '../env';
import { audit, type AuditActor } from '../audit/audit';
import { safeEqualHex, sha256 } from '../security/crypto';
import { forbidden, HttpError, unauthorized } from './errors';
import type { SectorScope } from '../repositories/institution';

export const SESSION_COOKIE = 'ccih_session';
export const CSRF_COOKIE = 'ccih_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface AuthContext {
  sessionId: string;
  csrfHash: string;
  userId: string;
  login: string;
  displayName: string;
  institutionId: string;
  roles: string[];
  permissions: Permission[];
  /** undefined = all sectors of the institution. */
  scope: SectorScope;
  expiresAt: Date;
  idleExpiresAt: Date;
  /** Temporary or expired password: only the password change is allowed until it is replaced. */
  mustChangePassword: boolean;
  /** The creator account: the only one that creates or changes system administrators. */
  isFounder: boolean;
  /** Business model of the user's organization (decides which permissions take effect). */
  organizationType: OrganizationType;
  organizationName: string;
  /** Consulting organizations: the clients this person may see (null = every client, or not applicable). */
  clientScope: string[] | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export function actorOf(req: FastifyRequest): AuditActor {
  return {
    institutionId: req.auth?.institutionId ?? null,
    userId: req.auth?.userId ?? null,
    login: req.auth?.login ?? null,
    ip: req.ip ?? null,
    userAgent: (req.headers['user-agent'] ?? '').slice(0, 300) || null,
  };
}

/** Resolves the session cookie into an AuthContext, enforcing idle and absolute timeouts. */
export function sessionLoader(db: Kysely<DB>, env: Env) {
  const idleMs = env.SESSION_IDLE_MINUTES * 60_000;
  return async function loadSession(req: FastifyRequest) {
    req.auth = null;
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const row = await db
      .selectFrom('session')
      .innerJoin('app_user', 'app_user.id', 'session.user_id')
      .innerJoin('institution', 'institution.id', 'app_user.institution_id')
      .select([
        'session.id as sessionId', 'session.csrf_hash', 'session.last_seen_at', 'session.expires_at', 'app_user.id as userId', 'app_user.login', 'app_user.display_name',
        'app_user.institution_id', 'app_user.active', 'app_user.status', 'app_user.valid_from', 'app_user.valid_until', 'app_user.is_founder', 'app_user.scope_all',
        'app_user.must_change_password', 'app_user.password_changed_at', 'institution.timezone', 'institution.organization_type', 'institution.name as institution_name',
      ])
      .where('session.token_hash', '=', sha256(token))
      .where('session.revoked_at', 'is', null)
      .executeTakeFirst();
    if (!row) return;
    const now = Date.now();
    const today = todayIn(row.timezone);
    const idleExpired = now - row.last_seen_at.getTime() > idleMs;
    const absoluteExpired = now > row.expires_at.getTime();
    // Account not active (pending, suspended, deactivated) or outside its validity window: the session ends.
    const outside = (row.valid_from != null && today < row.valid_from) || (row.valid_until != null && today > row.valid_until);
    if (idleExpired || absoluteExpired || !row.active || row.status !== 'ativo' || outside) {
      const reason = row.status !== 'ativo' || !row.active ? 'usuario_inativo' : outside ? 'fora_da_validade' : idleExpired ? 'inatividade' : 'tempo_maximo';
      await db.updateTable('session').set({ revoked_at: new Date(), revoked_reason: reason }).where('id', '=', row.sessionId).execute();
      await audit(db, { institutionId: row.institution_id, userId: row.userId, login: row.login, ip: req.ip, userAgent: null }, { action: 'session_expired', entity: 'session', entityId: row.sessionId, context: { reason } });
      return;
    }
    const [roles, scopes, grants] = await Promise.all([
      db.selectFrom('user_role').innerJoin('role', (j) => j.onRef('role.code', '=', 'user_role.role_code').onRef('role.institution_id', '=', 'user_role.institution_id')).select(['role.code', 'role.permissions']).where('user_role.user_id', '=', row.userId).execute(),
      row.scope_all ? Promise.resolve([]) : db.selectFrom('user_scope').select('sector_id').where('user_id', '=', row.userId).execute(),
      // Individual grants (express authorization), valid today.
      db.selectFrom('user_permission').select('permission').where('user_id', '=', row.userId).where('revoked_at', 'is', null)
        .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>=', today)])).execute(),
    ]);
    // Limited to the organization's model: a permission of the other model never takes effect, whatever a role or grant says.
    const permissions = effectivePermissions([...new Set([...roles.flatMap((r) => r.permissions), ...grants.map((g) => g.permission)])].filter(isPermission), row.organization_type);
    // Consultants see only the clients assigned to them today (an assignment ended on a date no longer counts from that date); the portfolio view sees every client.
    const clientScope = row.organization_type === 'consultoria' && !permissions.includes('consultoria:portfolio:all')
      ? (await db.selectFrom('client_assignment').select('client_id').where('user_id', '=', row.userId).where('institution_id', '=', row.institution_id)
        .where('starts_on', '<=', today).where((eb) => eb.or([eb('ends_on', 'is', null), eb('ends_on', '>', today)])).execute()).map((r) => r.client_id)
      : null;
    // Touch at most once a minute to keep writes low.
    let lastSeen = row.last_seen_at;
    if (now - lastSeen.getTime() > 60_000) {
      lastSeen = new Date(now);
      await db.updateTable('session').set({ last_seen_at: lastSeen }).where('id', '=', row.sessionId).execute();
    }
    req.auth = {
      sessionId: row.sessionId,
      csrfHash: row.csrf_hash,
      userId: row.userId,
      login: row.login,
      displayName: row.display_name,
      institutionId: row.institution_id,
      roles: roles.map((r) => r.code),
      permissions,
      scope: row.scope_all ? undefined : scopes.map((s) => s.sector_id),
      expiresAt: row.expires_at,
      idleExpiresAt: new Date(lastSeen.getTime() + idleMs),
      isFounder: row.is_founder,
      organizationType: row.organization_type,
      organizationName: row.institution_name,
      clientScope,
      mustChangePassword: row.must_change_password || (env.PASSWORD_MAX_AGE_DAYS > 0 && now - row.password_changed_at.getTime() > env.PASSWORD_MAX_AGE_DAYS * 86_400_000),
    };
  };
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  if (req.auth.mustChangePassword) throw new HttpError(403, 'troca_de_senha', 'Troque sua senha para continuar.');
  return req.auth;
}

/** Fastify preHandler: authenticated + permission, denial is audited. */
export function requirePermission(db: Kysely<DB>, ...anyOf: Permission[]) {
  return async (req: FastifyRequest) => {
    const auth = requireAuth(req);
    if (anyOf.some((p) => auth.permissions.includes(p))) return;
    await audit(db, actorOf(req), { action: 'access_denied', entity: 'route', entityId: `${req.method} ${req.routeOptions.url ?? req.url}`, context: { required: anyOf } });
    throw forbidden();
  };
}

/**
 * Routes of one business model only (registered as a hook on the model's route group): a user of an
 * organization of the other model gets 404, as if the route did not exist, and the attempt is logged.
 */
export function requireModel(db: Kysely<DB>, model: OrganizationType) {
  return async (req: FastifyRequest) => {
    if (!req.auth || req.auth.organizationType === model) return; // unauthenticated: the route itself answers 401
    await audit(db, actorOf(req), { action: 'access_denied', entity: 'route', entityId: `${req.method} ${req.routeOptions.url ?? req.url}`, context: { requiredModel: model, organizationType: req.auth.organizationType } });
    throw new HttpError(404, 'nao_encontrado', 'Recurso não encontrado.');
  };
}

/**
 * CSRF for state-changing requests: SameSite=Strict cookies + double-submit token bound to the
 * session + Origin check against the configured web origin.
 */
export function csrfGuard(env: Env) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    checkOrigin(req, env);
    if (!req.auth) return; // unauthenticated routes (login) rely on the origin check
    const header = req.headers[CSRF_HEADER];
    if (typeof header !== 'string' || !safeEqualHex(sha256(header), req.auth.csrfHash)) {
      throw new HttpError(403, 'csrf', 'Requisição recusada por segurança. Recarregue a página e tente novamente.');
    }
  };
}

export function checkOrigin(req: FastifyRequest, env: Env) {
  const origin = req.headers.origin;
  if (origin && origin !== env.APP_ORIGIN) throw new HttpError(403, 'origem', 'Origem da requisição não autorizada.');
}
