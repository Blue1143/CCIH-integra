import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { todayIn } from '@ccih/domain';
import type { DB } from '../db/types';
import type { Env } from '../env';
import { audit } from '../audit/audit';
import { burnPasswordCheck, hashPassword, needsRehash, newToken, passwordProblem, sha256, verifyPassword } from '../security/crypto';
import { CSRF_COOKIE, SESSION_COOKIE, actorOf, type AuthContext } from '../http/auth';
import { HttpError, parse } from '../http/errors';

const PasswordBody = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(1).max(128) }).strict();

const LoginBody = z.object({ login: z.string().trim().toLowerCase().min(3).max(60), password: z.string().min(1).max(128) }).strict();

const INVALID = () => new HttpError(401, 'credenciais', 'Usuário ou senha inválidos, ou conta temporariamente bloqueada.');

export function meResponse(auth: AuthContext, idleMinutes: number) {
  return {
    authenticated: true as const,
    user: { id: auth.userId, login: auth.login, displayName: auth.displayName },
    roles: auth.roles,
    permissions: auth.permissions,
    scope: auth.scope ?? null,
    session: { expiresAt: auth.expiresAt.toISOString(), idleExpiresAt: auth.idleExpiresAt.toISOString(), idleMinutes },
    mustChangePassword: auth.mustChangePassword,
    isFounder: auth.isFounder,
  };
}

export async function authRoutes(app: FastifyInstance, { db, env }: { db: Kysely<DB>; env: Env }) {
  const cookieBase = { path: '/', sameSite: 'strict' as const, secure: env.COOKIE_SECURE };

  const clearCookies = (reply: FastifyReply) => {
    reply.clearCookie(SESSION_COOKIE, cookieBase);
    reply.clearCookie(CSRF_COOKIE, cookieBase);
  };

  app.post('/auth/login', { config: { rateLimit: { max: env.LOGIN_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute', keyGenerator: (req) => `ip:${req.ip}` } } }, async (req, reply) => {
    const { login, password } = parse(LoginBody, req.body);
    const user = await db.selectFrom('app_user').selectAll().where('login', '=', login).executeTakeFirst();
    const actor = { ...actorOf(req), institutionId: user?.institution_id ?? null, userId: user?.id ?? null, login };

    // Pending, suspended or deactivated accounts and accounts outside their validity window do not sign in.
    const today = user ? todayIn((await db.selectFrom('institution').select('timezone').where('id', '=', user.institution_id).executeTakeFirstOrThrow()).timezone) : '';
    const outside = !!user && ((user.valid_from != null && today < user.valid_from) || (user.valid_until != null && today > user.valid_until));
    if (!user || !user.active || user.status !== 'ativo' || outside) {
      await burnPasswordCheck(password);
      await audit(db, actor, { action: 'login_failure', entity: 'app_user', entityId: user?.id ?? null, context: { reason: !user ? 'login_inexistente' : outside ? 'fora_da_validade' : user.status !== 'ativo' ? `conta_${user.status}` : 'inativo' } });
      throw INVALID();
    }
    const locked = user.locked_until && user.locked_until.getTime() > Date.now();
    const ok = await verifyPassword(user.password_hash, password);
    if (locked || !ok) {
      let attempts = user.failed_attempts;
      let lockedUntil = user.locked_until;
      if (!locked) {
        // Atomic increment: concurrent wrong passwords cannot undercount.
        const updated = await db.updateTable('app_user').set((eb) => ({ failed_attempts: eb('failed_attempts', '+', 1) })).where('id', '=', user.id).returning('failed_attempts').executeTakeFirstOrThrow();
        attempts = updated.failed_attempts;
        if (attempts >= env.LOGIN_MAX_ATTEMPTS) {
          lockedUntil = new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60_000);
          await db.updateTable('app_user').set({ locked_until: lockedUntil, failed_attempts: 0 }).where('id', '=', user.id).execute();
        }
      }
      await audit(db, actor, { action: 'login_failure', entity: 'app_user', entityId: user.id, context: { reason: locked ? 'bloqueado' : 'senha_incorreta', attempts, lockedUntil: lockedUntil?.toISOString() ?? null } });
      throw INVALID();
    }

    const token = newToken();
    const csrf = newToken();
    const now = new Date();
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('app_user')
        .set({ failed_attempts: 0, locked_until: null, last_login_at: now, ...(needsRehash(user.password_hash) ? { password_hash: await hashPassword(password) } : {}) })
        .where('id', '=', user.id)
        .execute();
      const session = await trx
        .insertInto('session')
        .values({ user_id: user.id, token_hash: sha256(token), csrf_hash: sha256(csrf), last_seen_at: now, expires_at: new Date(now.getTime() + env.SESSION_ABSOLUTE_HOURS * 3_600_000), ip: req.ip ?? null, user_agent: (req.headers['user-agent'] ?? '').slice(0, 300) || null })
        .returning('id')
        .executeTakeFirstOrThrow();
      await audit(trx, actor, { action: 'login_success', entity: 'session', entityId: session.id });
    });

    reply.setCookie(SESSION_COOKIE, token, { ...cookieBase, httpOnly: true, maxAge: env.SESSION_ABSOLUTE_HOURS * 3600 });
    reply.setCookie(CSRF_COOKIE, csrf, { ...cookieBase, httpOnly: false, maxAge: env.SESSION_ABSOLUTE_HOURS * 3600 });
    return { ok: true, csrfToken: csrf };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.auth) {
      await db.updateTable('session').set({ revoked_at: new Date(), revoked_reason: 'logout' }).where('id', '=', req.auth.sessionId).execute();
      await audit(db, actorOf(req), { action: 'logout', entity: 'session', entityId: req.auth.sessionId });
    }
    clearCookies(reply);
    return { ok: true };
  });

  /** Own password change: current password required; other sessions end; the password is never logged. */
  app.post('/auth/password', { config: { rateLimit: { max: env.LOGIN_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute', keyGenerator: (req) => `ip:${req.ip}` } } }, async (req) => {
    if (!req.auth) throw new HttpError(401, 'nao_autenticado', 'Sessão inexistente ou expirada. Entre novamente.');
    const auth = req.auth;
    const b = parse(PasswordBody, req.body);
    const user = await db.selectFrom('app_user').select(['password_hash', 'login']).where('id', '=', auth.userId).executeTakeFirstOrThrow();
    if (!(await verifyPassword(user.password_hash, b.currentPassword))) {
      await audit(db, actorOf(req), { action: 'login_failure', entity: 'app_user_password', entityId: auth.userId, context: { reason: 'senha_atual_incorreta' } });
      throw new HttpError(400, 'validacao', 'Senha atual incorreta.', [{ path: 'currentPassword', message: 'Senha atual incorreta.' }]);
    }
    const problem = passwordProblem(b.newPassword)
      ?? (b.newPassword === b.currentPassword ? 'A nova senha deve ser diferente da atual.' : null)
      ?? (b.newPassword.toLowerCase().includes(user.login.toLowerCase()) ? 'A senha não pode conter o nome de usuário.' : null);
    if (problem) throw new HttpError(400, 'validacao', problem, [{ path: 'newPassword', message: problem }]);
    const hash = await hashPassword(b.newPassword);
    await db.transaction().execute(async (trx) => {
      await trx.updateTable('app_user').set({ password_hash: hash, password_changed_at: new Date(), must_change_password: false }).where('id', '=', auth.userId).execute();
      await trx.updateTable('session').set({ revoked_at: new Date(), revoked_reason: 'senha_alterada' }).where('user_id', '=', auth.userId).where('revoked_at', 'is', null).where('id', '!=', auth.sessionId).execute();
      await audit(trx, actorOf(req), { action: 'update', entity: 'app_user_password', entityId: auth.userId, context: { otherSessionsEnded: true } });
    });
    return { ok: true };
  });

  /** Session probe: anonymous visitors get 200 { authenticated: false } (protected routes still answer 401). */
  app.get('/auth/me', async (req) => (req.auth ? meResponse(req.auth, env.SESSION_IDLE_MINUTES) : { authenticated: false }));
}
