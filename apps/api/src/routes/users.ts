import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import {
  PERMISSIONS, ROLE_LABEL, ROLE_MODULE, accountChangeRefusal, assignableRoles, canManageAccount, checkAccess, grantablePermissions, managedModules, todayIn,
  type AccountStatus, type Grantor, type Permission, type ProfessionalCategory, type RoleCode, type UserAccessInput, type UserAccountDto, type UserHistoryEntry,
} from '@ccih/domain';
import type { DB } from '../db/types';
import { audit } from '../audit/audit';
import { actorOf, requireAuth, requirePermission, type AuthContext } from '../http/auth';
import { HttpError, conflict, forbidden, notFound, parse } from '../http/errors';
import { hashPassword } from '../security/crypto';

const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use AAAA-MM-DD.');
const ROLE = z.enum(Object.keys(ROLE_LABEL) as [RoleCode, ...RoleCode[]]);
const Access = z.object({
  displayName: z.string().trim().min(3).max(120),
  email: z.string().trim().max(160).nullable(),
  registration: z.string().trim().max(40).nullable(),
  category: z.enum(['enfermeiro', 'tecnico_enfermagem', 'medico', 'administrativo', 'aprendiz', 'outro']).nullable(),
  functionRole: ROLE,
  extraRoles: z.array(ROLE).max(6),
  scopeAll: z.boolean(),
  sectorIds: z.array(z.string().uuid()).max(200),
  status: z.enum(['pendente', 'ativo', 'suspenso', 'desativado']),
  statusReason: z.string().trim().max(500).nullable(),
  validFrom: IsoDay.nullable(),
  validUntil: IsoDay.nullable(),
  supervisorId: z.string().uuid().nullable(),
  grants: z.array(z.object({ permission: z.string().max(60), validUntil: IsoDay.nullable() }).strict()).max(60),
  justification: z.string().trim().min(10, 'Descreva o motivo (mínimo 10 caracteres).').max(500),
});
const UserCreate = Access.extend({ login: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,60}$/, 'Use 3 a 60 letras minúsculas, números, ponto, hífen ou sublinhado.') }).strict();
const UserUpdate = Access.extend({ rowVersion: z.number().int().min(1) }).strict();
const ListQuery = z.object({
  q: z.string().trim().max(80).optional(), role: ROLE.optional(), status: z.enum(['pendente', 'ativo', 'suspenso', 'desativado']).optional(),
  sectorId: z.string().uuid().optional(), createdFrom: IsoDay.optional(), createdTo: IsoDay.optional(), authorizedBy: z.string().uuid().optional(),
}).strict();

/** Temporary password shown once to the manager; the user must replace it at first access. */
const temporaryPassword = () => `Tmp-${randomBytes(9).toString('base64url')}-${randomBytes(2).toString('hex')}9a!`;

const MANAGE = ['users:manage', 'users:manage:ccih', 'users:manage:cme'] as const;
const grantorOf = (auth: AuthContext): Grantor & { userId: string } => ({ permissions: auth.permissions, isFounder: auth.isFounder, userId: auth.userId });

type Db = Kysely<DB> | Transaction<DB>;

/** Effective permissions of an account (its functions plus valid individual grants), for the audit trail. */
async function accessSnapshot(db: Db, userId: string, today: string) {
  const [u, roles, grants, scopes] = await Promise.all([
    db.selectFrom('app_user').select(['function_role', 'status', 'status_reason', 'scope_all', 'valid_from', 'valid_until', 'supervisor_id']).where('id', '=', userId).executeTakeFirstOrThrow(),
    db.selectFrom('user_role').innerJoin('role', (j) => j.onRef('role.code', '=', 'user_role.role_code').onRef('role.institution_id', '=', 'user_role.institution_id'))
      .select(['role.code', 'role.permissions']).where('user_role.user_id', '=', userId).execute(),
    db.selectFrom('user_permission').select(['permission', 'valid_until']).where('user_id', '=', userId).where('revoked_at', 'is', null).execute(),
    db.selectFrom('user_scope').select('sector_id').where('user_id', '=', userId).execute(),
  ]);
  const validGrants = grants.filter((g) => !g.valid_until || g.valid_until >= today);
  return {
    functionRole: u.function_role, roles: roles.map((r) => r.code).sort(), status: u.status, statusReason: u.status_reason,
    scopeAll: u.scope_all, sectorIds: scopes.map((s) => s.sector_id).sort(), validFrom: u.valid_from, validUntil: u.valid_until, supervisorId: u.supervisor_id,
    grants: grants.map((g) => ({ permission: g.permission, validUntil: g.valid_until })).sort((a, b) => a.permission.localeCompare(b.permission)),
    permissions: [...new Set([...roles.flatMap((r) => r.permissions), ...validGrants.map((g) => g.permission)])].sort(),
  };
}

export async function userRoutes(app: FastifyInstance, { db }: { db: Kysely<DB> }) {
  const read = { preHandler: requirePermission(db, 'users:view', ...MANAGE) };
  const manage = { preHandler: requirePermission(db, ...MANAGE) };

  const today = async (auth: AuthContext) => todayIn((await db.selectFrom('institution').select('timezone').where('id', '=', auth.institutionId).executeTakeFirstOrThrow()).timezone);

  /** Denials of account actions are logged like any other denied access. */
  const deny = async (req: FastifyRequest, message: string, entityId: string | null) => {
    await audit(db, actorOf(req), { action: 'access_denied', entity: 'app_user_access', entityId, context: { reason: message } });
    throw new HttpError(403, 'sem_permissao', message);
  };

  /** Giving a function or permission beyond one's own power is a denied access (logged), not a form error. */
  const guardPower = async (req: FastifyRequest, auth: AuthContext, b: UserAccessInput, targetId: string | null) => {
    const grantor = grantorOf(auth);
    const roles = [...new Set([b.functionRole, ...b.extraRoles])];
    const allowed = assignableRoles(grantor);
    const beyond = roles.filter((r) => !allowed.includes(r));
    if (beyond.length) {
      await deny(req, beyond.includes('admin') ? 'Somente a conta criadora atribui a função Administrador do sistema.' : `Seu perfil não pode atribuir: ${beyond.map((r) => ROLE_LABEL[r]).join(', ')}.`, targetId);
    }
    const grantable = grantablePermissions(grantor, roles);
    const notGrantable = b.grants.filter((g) => !grantable.includes(g.permission as Permission));
    if (notGrantable.length) await deny(req, `Permissão que você não pode conceder a esta função: ${notGrantable.map((g) => g.permission).join(', ')}.`, targetId);
  };

  const validate = async (trx: Db, auth: AuthContext, b: UserAccessInput, day: string, excludeId: string | null) => {
    const problems = checkAccess(b, grantorOf(auth), day);
    const sectorIds = b.scopeAll ? [] : [...new Set(b.sectorIds)];
    if (sectorIds.length) {
      const valid = await trx.selectFrom('sector').select('id').where('institution_id', '=', auth.institutionId).where('id', 'in', sectorIds).execute();
      if (valid.length !== sectorIds.length) problems.push({ path: 'sectorIds', message: 'Setor inexistente.' });
    }
    if (b.supervisorId) {
      const sup = await trx.selectFrom('app_user').select(['id', 'status']).where('id', '=', b.supervisorId).where('institution_id', '=', auth.institutionId).executeTakeFirst();
      if (!sup || sup.status !== 'ativo' || sup.id === excludeId) problems.push({ path: 'supervisorId', message: 'Supervisor inexistente ou inativo.' });
    }
    if (problems.length) throw new HttpError(400, 'validacao', 'Não é possível salvar o acesso. Revise os campos indicados.', problems);
    return sectorIds;
  };

  /** Writes functions, scope and individual grants (grants removed are revoked, never deleted). */
  const writeAccess = async (trx: Transaction<DB>, auth: AuthContext, userId: string, b: UserAccessInput, sectorIds: string[]) => {
    const roles = [...new Set([b.functionRole, ...b.extraRoles])];
    await trx.deleteFrom('user_role').where('user_id', '=', userId).where('role_code', 'not in', roles).execute();
    const existing = (await trx.selectFrom('user_role').select('role_code').where('user_id', '=', userId).execute()).map((r) => r.role_code);
    const missing = roles.filter((r) => !existing.includes(r));
    if (missing.length) await trx.insertInto('user_role').values(missing.map((code) => ({ user_id: userId, institution_id: auth.institutionId, role_code: code }))).execute();
    await trx.deleteFrom('user_scope').where('user_id', '=', userId).execute();
    if (sectorIds.length) await trx.insertInto('user_scope').values(sectorIds.map((sector_id) => ({ user_id: userId, sector_id }))).execute();
    const current = await trx.selectFrom('user_permission').select(['id', 'permission', 'valid_until']).where('user_id', '=', userId).where('revoked_at', 'is', null).execute();
    const wanted = new Map(b.grants.map((g) => [g.permission, g.validUntil]));
    const now = new Date();
    for (const c of current) {
      if (!wanted.has(c.permission) || wanted.get(c.permission) !== c.valid_until) {
        await trx.updateTable('user_permission').set({ revoked_at: now, revoked_by_name: auth.displayName }).where('id', '=', c.id).execute();
      }
    }
    const kept = new Set(current.filter((c) => wanted.has(c.permission) && wanted.get(c.permission) === c.valid_until).map((c) => c.permission));
    const added = b.grants.filter((g) => !kept.has(g.permission));
    if (added.length) {
      await trx.insertInto('user_permission').values(added.map((g) => ({
        user_id: userId, permission: g.permission, granted_by: auth.userId, granted_by_name: auth.displayName, justification: b.justification, valid_until: g.validUntil,
      }))).execute();
    }
  };

  /** Registration number lives in the professional record (created when needed). */
  const writeProfessional = async (trx: Transaction<DB>, auth: AuthContext, userId: string, name: string, registration: string | null) => {
    const u = await trx.selectFrom('app_user').select('professional_id').where('id', '=', userId).executeTakeFirstOrThrow();
    if (u.professional_id) await trx.updateTable('professional').set({ name, registration }).where('id', '=', u.professional_id).execute();
    else if (registration) {
      const prof = await trx.insertInto('professional').values({ institution_id: auth.institutionId, name, registration, job_role_id: null }).returning('id').executeTakeFirstOrThrow();
      await trx.updateTable('app_user').set({ professional_id: prof.id }).where('id', '=', userId).execute();
    }
  };

  /* ---------- Reading ---------- */

  app.get('/users', read, async (req): Promise<{ users: UserAccountDto[] }> => {
    const auth = requireAuth(req);
    const q = parse(ListQuery, req.query);
    let list = db.selectFrom('app_user as u')
      .leftJoin('professional as p', 'p.id', 'u.professional_id')
      .leftJoin('app_user as c', 'c.id', 'u.created_by')
      .leftJoin('app_user as s', 's.id', 'u.supervisor_id')
      .select([
        'u.id', 'u.login', 'u.display_name', 'u.email', 'p.registration', 'u.professional_category', 'u.function_role', 'u.status', 'u.status_reason', 'u.scope_all',
        'u.is_founder', 'u.created_at', 'c.display_name as created_by_name', 'u.authorized_by_name', 'u.permissions_changed_at', 'u.valid_from', 'u.valid_until',
        'u.supervisor_id', 's.display_name as supervisor_name', 'u.locked_until', 'u.last_login_at', 'u.row_version',
      ])
      .where('u.institution_id', '=', auth.institutionId);
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      list = list.where((eb) => eb.or([eb('u.display_name', 'ilike', like), eb('u.login', 'ilike', like), eb('u.email', 'ilike', like)]));
    }
    if (q.status) list = list.where('u.status', '=', q.status);
    if (q.createdFrom) list = list.where('u.created_at', '>=', new Date(`${q.createdFrom}T00:00:00Z`));
    if (q.createdTo) list = list.where('u.created_at', '<', new Date(new Date(`${q.createdTo}T00:00:00Z`).getTime() + 86_400_000));
    if (q.authorizedBy) list = list.where('u.authorized_by', '=', q.authorizedBy);
    const users = await list.orderBy('u.display_name').execute();
    const ids = users.map((u) => u.id);
    const [roles, scopes, grants] = ids.length ? await Promise.all([
      db.selectFrom('user_role').select(['user_id', 'role_code']).where('user_id', 'in', ids).execute(),
      db.selectFrom('user_scope').select(['user_id', 'sector_id']).where('user_id', 'in', ids).execute(),
      db.selectFrom('user_permission').select(['id', 'user_id', 'permission', 'granted_by_name', 'justification', 'valid_until', 'created_at']).where('user_id', 'in', ids).where('revoked_at', 'is', null).execute(),
    ]) : [[], [], []];
    const grantor = grantorOf(auth);
    const seesAll = auth.permissions.includes('users:view') || auth.permissions.includes('users:manage');
    const rows = users.map((u): UserAccountDto => {
      const r = roles.filter((x) => x.user_id === u.id).map((x) => x.role_code as RoleCode);
      return {
        id: u.id, login: u.login, displayName: u.display_name, email: u.email, registration: u.registration ?? null, category: u.professional_category as ProfessionalCategory | null,
        functionRole: (u.function_role as RoleCode | null) ?? r[0] ?? null, roles: r, status: u.status as AccountStatus, statusReason: u.status_reason, scopeAll: u.scope_all,
        sectorIds: scopes.filter((s) => s.user_id === u.id).map((s) => s.sector_id), isFounder: u.is_founder, createdAt: u.created_at.toISOString(),
        createdByName: u.created_by_name ?? null, authorizedByName: u.authorized_by_name, permissionsChangedAt: u.permissions_changed_at?.toISOString() ?? null,
        validFrom: u.valid_from, validUntil: u.valid_until, supervisorId: u.supervisor_id, supervisorName: u.supervisor_name ?? null,
        lockedUntil: u.locked_until && u.locked_until.getTime() > Date.now() ? u.locked_until.toISOString() : null, lastLoginAt: u.last_login_at?.toISOString() ?? null,
        grants: grants.filter((g) => g.user_id === u.id).map((g) => ({ id: g.id, permission: g.permission as UserAccountDto['grants'][number]['permission'], grantedByName: g.granted_by_name, justification: g.justification, validUntil: g.valid_until, createdAt: g.created_at.toISOString() })),
        manageable: u.id !== auth.userId && !u.is_founder && canManageAccount(grantor, { roles: r, isFounder: u.is_founder }),
        rowVersion: u.row_version,
      };
    });
    // A module administrator sees the accounts of its module only (and its own).
    const visible = seesAll ? rows : rows.filter((u) => u.manageable || u.id === auth.userId);
    return { users: visible.filter((u) => (!q.role || u.roles.includes(q.role)) && (!q.sectorId || u.scopeAll || u.sectorIds.includes(q.sectorId))) };
  });

  /** What the signed-in manager may do: functions to assign and people who can supervise. */
  app.get('/users/meta', read, async (req) => {
    const auth = requireAuth(req);
    const supervisors = await db.selectFrom('app_user').innerJoin('user_role', 'user_role.user_id', 'app_user.id').select(['app_user.id', 'app_user.display_name'])
      .where('app_user.institution_id', '=', auth.institutionId).where('app_user.status', '=', 'ativo').where('user_role.role_code', '!=', 'aprendiz').distinct().orderBy('app_user.display_name').execute();
    return {
      assignableRoles: assignableRoles(grantorOf(auth)), modules: managedModules(grantorOf(auth)), roleModules: ROLE_MODULE, permissions: PERMISSIONS,
      supervisors: supervisors.map((s) => ({ id: s.id, name: s.display_name })),
    };
  });

  /** Changes of one account, newest first (who, when, before, after and why). */
  app.get<{ Params: { id: string } }>('/users/:id/history', read, async (req): Promise<{ entries: UserHistoryEntry[] }> => {
    const auth = requireAuth(req);
    const id = parse(z.string().uuid(), req.params.id);
    const target = await db.selectFrom('app_user').select(['id', 'is_founder']).where('id', '=', id).where('institution_id', '=', auth.institutionId).executeTakeFirst();
    if (!target) throw notFound('Usuário');
    const seesAll = auth.permissions.includes('users:view') || auth.permissions.includes('users:manage');
    if (!seesAll && id !== auth.userId) {
      const r = (await db.selectFrom('user_role').select('role_code').where('user_id', '=', id).execute()).map((x) => x.role_code as RoleCode);
      if (!canManageAccount(grantorOf(auth), { roles: r, isFounder: target.is_founder })) await deny(req, 'Esta conta tem funções fora do seu módulo.', id);
    }
    const rows = await db.selectFrom('audit_log').select(['id', 'occurred_at', 'user_login', 'action', 'entity', 'before', 'after', 'context'])
      .where('institution_id', '=', auth.institutionId).where('entity', 'in', ['app_user', 'app_user_access', 'app_user_password']).where('entity_id', '=', id)
      .orderBy('id', 'desc').limit(200).execute();
    return {
      entries: rows.map((r) => ({
        id: r.id, at: r.occurred_at.toISOString(), by: r.user_login, action: r.action, entity: r.entity, before: r.before, after: r.after,
        justification: ((r.context as { justification?: string } | null)?.justification) ?? null,
      })),
    };
  });

  /* ---------- Creating and changing accounts ---------- */

  app.post('/users', manage, async (req, reply) => {
    const auth = requireAuth(req);
    const b = parse(UserCreate, req.body);
    const day = await today(auth);
    await guardPower(req, auth, b, null);
    const password = temporaryPassword();
    const hash = await hashPassword(password);
    const created = await db.transaction().execute(async (trx) => {
      if (await trx.selectFrom('app_user').select('id').where('login', '=', b.login).executeTakeFirst()) throw new HttpError(409, 'duplicado', 'Este login já está em uso.', [{ path: 'login', message: 'Login já utilizado.' }]);
      const sectorIds = await validate(trx, auth, b, day, null);
      const now = new Date();
      const user = await trx.insertInto('app_user').values({
        institution_id: auth.institutionId, professional_id: null, login: b.login, display_name: b.displayName, password_hash: hash, scope_all: b.scopeAll,
        password_changed_at: now, must_change_password: true, active: b.status === 'ativo', status: b.status, status_reason: b.statusReason,
        email: b.email, professional_category: b.category, function_role: b.functionRole, created_by: auth.userId, authorized_by: auth.userId, authorized_by_name: auth.displayName,
        permissions_changed_at: now, valid_from: b.validFrom, valid_until: b.validUntil, supervisor_id: b.supervisorId,
      }).returning('id').executeTakeFirstOrThrow();
      await writeProfessional(trx, auth, user.id, b.displayName, b.registration);
      await writeAccess(trx, auth, user.id, b, sectorIds);
      const after = await accessSnapshot(trx, user.id, day);
      await audit(trx, actorOf(req), { action: 'create', entity: 'app_user', entityId: user.id, after: { login: b.login, displayName: b.displayName, email: b.email, category: b.category, ...after, temporaryPassword: true }, context: { justification: b.justification } });
      return user;
    });
    reply.code(201);
    return { id: created.id, temporaryPassword: password };
  });

  app.put<{ Params: { id: string } }>('/users/:id', manage, async (req) => {
    const auth = requireAuth(req);
    const id = parse(z.string().uuid(), req.params.id);
    const b = parse(UserUpdate, req.body);
    const day = await today(auth);
    const target = await db.selectFrom('app_user').select(['id', 'is_founder', 'row_version']).where('id', '=', id).where('institution_id', '=', auth.institutionId).executeTakeFirst();
    if (!target) throw notFound('Usuário');
    const currentRoles = (await db.selectFrom('user_role').select('role_code').where('user_id', '=', id).execute()).map((r) => r.role_code as RoleCode);
    const refusal = accountChangeRefusal(grantorOf(auth), { id, roles: currentRoles, isFounder: target.is_founder });
    if (refusal) await deny(req, refusal, id);
    await guardPower(req, auth, b, id);
    return db.transaction().execute(async (trx) => {
      const locked = await trx.selectFrom('app_user').select('row_version').where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
      if (locked.row_version !== b.rowVersion) throw conflict();
      const sectorIds = await validate(trx, auth, b, day, id);
      const before = await accessSnapshot(trx, id, day);
      await trx.updateTable('app_user').set({
        display_name: b.displayName, email: b.email, professional_category: b.category, function_role: b.functionRole, scope_all: b.scopeAll,
        status: b.status, status_reason: b.statusReason, active: b.status === 'ativo', valid_from: b.validFrom, valid_until: b.validUntil, supervisor_id: b.supervisorId,
        authorized_by: auth.userId, authorized_by_name: auth.displayName, permissions_changed_at: new Date(), row_version: locked.row_version + 1,
      }).where('id', '=', id).execute();
      await writeProfessional(trx, auth, id, b.displayName, b.registration);
      await writeAccess(trx, auth, id, b, sectorIds);
      const after = await accessSnapshot(trx, id, day);
      // Any change of access takes effect at once: the account's open sessions end.
      await trx.updateTable('session').set({ revoked_at: new Date(), revoked_reason: 'permissoes_alteradas' }).where('user_id', '=', id).where('revoked_at', 'is', null).execute();
      await audit(trx, actorOf(req), { action: 'update', entity: 'app_user_access', entityId: id, before, after, context: { justification: b.justification, sessionsEnded: true } });
      return { ok: true, rowVersion: locked.row_version + 1 };
    });
  });

  /** Password reset and unlock follow the same rules as changing access. */
  const guardTarget = async (req: FastifyRequest, auth: AuthContext, id: string) => {
    const target = await db.selectFrom('app_user').select(['id', 'is_founder']).where('id', '=', id).where('institution_id', '=', auth.institutionId).executeTakeFirst();
    if (!target) throw notFound('Usuário');
    const roles = (await db.selectFrom('user_role').select('role_code').where('user_id', '=', id).execute()).map((r) => r.role_code as RoleCode);
    const refusal = id === auth.userId ? 'Use “Minha conta” para trocar a sua própria senha.' : accountChangeRefusal(grantorOf(auth), { id, roles, isFounder: target.is_founder });
    if (refusal) await deny(req, refusal, id);
  };

  app.post<{ Params: { id: string } }>('/users/:id/reset-password', manage, async (req) => {
    const auth = requireAuth(req);
    const id = parse(z.string().uuid(), req.params.id);
    const { justification } = parse(z.object({ justification: z.string().trim().min(10, 'Descreva o motivo (mínimo 10 caracteres).').max(500) }).strict(), req.body ?? {});
    await guardTarget(req, auth, id);
    const password = temporaryPassword();
    const hash = await hashPassword(password);
    await db.transaction().execute(async (trx) => {
      await trx.updateTable('app_user').set({ password_hash: hash, must_change_password: true, password_changed_at: new Date(), failed_attempts: 0, locked_until: null }).where('id', '=', id).execute();
      await trx.updateTable('session').set({ revoked_at: new Date(), revoked_reason: 'senha_redefinida' }).where('user_id', '=', id).where('revoked_at', 'is', null).execute();
      await audit(trx, actorOf(req), { action: 'update', entity: 'app_user_password', entityId: id, context: { justification, temporaryPassword: true, sessionsEnded: true } });
    });
    return { ok: true, temporaryPassword: password };
  });

  app.post<{ Params: { id: string } }>('/users/:id/unlock', manage, async (req) => {
    const auth = requireAuth(req);
    const id = parse(z.string().uuid(), req.params.id);
    await guardTarget(req, auth, id);
    await db.updateTable('app_user').set({ locked_until: null, failed_attempts: 0 }).where('id', '=', id).execute();
    await audit(db, actorOf(req), { action: 'unlock', entity: 'app_user', entityId: id });
    return { ok: true };
  });

  app.get('/roles', read, async (req) => {
    const auth = requireAuth(req);
    if (!auth.permissions.some((p) => p === 'users:view' || p.startsWith('users:manage'))) throw forbidden();
    const roles = await db.selectFrom('role').select(['code', 'name', 'permissions', 'module']).where('institution_id', '=', auth.institutionId).orderBy('name').execute();
    return { roles, permissions: PERMISSIONS };
  });
}
