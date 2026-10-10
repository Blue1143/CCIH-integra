import type { Kysely } from 'kysely';
import type { DB } from '../db/types';
import { audit } from '../audit/audit';
import { hashPassword, passwordProblem } from '../security/crypto';

export interface FounderInput { login: string; password: string; displayName: string; institutionId?: string }
export interface FounderResult { id: string; login: string; temporaryPassword: boolean }

/**
 * Creates the creator account (one per institution). Run only from the server, by whoever installs
 * the system; no credential lives in the code or in the repository. A password outside the policy
 * is accepted only as a temporary one: the account must replace it at first access.
 */
export async function createFounder(db: Kysely<DB>, input: FounderInput): Promise<FounderResult> {
  const login = input.login.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,60}$/.test(login)) throw new Error('Login inválido: use 3 a 60 letras, números, ponto, hífen ou sublinhado.');
  if (input.password.length < 8) throw new Error('Senha inicial curta demais (mínimo 8 caracteres).');
  if (input.displayName.trim().length < 3) throw new Error('Informe o nome do responsável pela conta.');
  const institutions = await db.selectFrom('institution').select('id').execute();
  const institutionId = input.institutionId ?? (institutions.length === 1 ? institutions[0]!.id : null);
  if (!institutionId || !institutions.some((i) => i.id === institutionId)) throw new Error('Informe a instituição (há nenhuma ou mais de uma no banco).');
  const temporary = passwordProblem(input.password) !== null;
  const hash = await hashPassword(input.password);
  return db.transaction().execute(async (trx) => {
    if (await trx.selectFrom('app_user').select('id').where('institution_id', '=', institutionId).where('is_founder', '=', true).executeTakeFirst()) {
      throw new Error('Esta instituição já tem uma conta criadora. Novos administradores são criados por ela, dentro do sistema.');
    }
    if (await trx.selectFrom('app_user').select('id').where('login', '=', login).executeTakeFirst()) throw new Error('Este login já está em uso.');
    const now = new Date();
    const user = await trx.insertInto('app_user').values({
      institution_id: institutionId, professional_id: null, login, display_name: input.displayName.trim(), password_hash: hash, scope_all: true, password_changed_at: now,
      must_change_password: temporary, status: 'ativo', function_role: 'admin', professional_category: 'administrativo', is_founder: true,
      authorized_by_name: 'Instalação (comando local)', permissions_changed_at: now,
    }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('user_role').values({ user_id: user.id, institution_id: institutionId, role_code: 'admin' }).execute();
    await audit(trx, { institutionId, userId: null, login: 'instalacao', ip: null, userAgent: 'admin:bootstrap' }, {
      action: 'create', entity: 'app_user', entityId: user.id, after: { login, displayName: input.displayName.trim(), roles: ['admin'], founder: true, temporaryPassword: temporary },
      context: { justification: 'Criação da conta criadora pelo comando local de instalação.' },
    });
    return { id: user.id, login, temporaryPassword: temporary };
  });
}
