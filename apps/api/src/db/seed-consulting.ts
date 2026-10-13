import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { DEFAULT_ROLE_PERMISSIONS, ROLE_LABEL, ROLE_MODULE, rolesOfModel, type RoleCode } from '@ccih/domain';
import { audit } from '../audit/audit';
import { hashPassword } from '../security/crypto';
import type { DB } from './types';

/**
 * Synthetic consulting organization for demonstration and end-to-end tests (flagged data_origin =
 * 'demo'). It starts with its administrator only: the consulting modules are filled by real use,
 * never with invented results.
 */
export async function seedDemoConsulting(db: Kysely<DB>, opts: { password?: string; now?: Date } = {}): Promise<{ institutionId: string; credentials: Array<{ login: string; role: RoleCode; password: string }> }> {
  const now = opts.now ?? new Date();
  return db.transaction().execute(async (trx) => {
    const inst = await trx.insertInto('institution').values({ name: 'Consultoria de demonstração', legal_name: null, cnpj: null, cnes: null, timezone: 'America/Sao_Paulo', data_origin: 'demo', organization_type: 'consultoria' }).returning('id').executeTakeFirstOrThrow();
    for (const code of rolesOfModel('consultoria')) {
      await trx.insertInto('role').values({ institution_id: inst.id, code, name: ROLE_LABEL[code], permissions: DEFAULT_ROLE_PERMISSIONS[code], module: ROLE_MODULE[code] }).execute();
    }
    const password = opts.password ?? `${randomBytes(9).toString('base64url')}-Aa1!`;
    const user = await trx.insertInto('app_user').values({
      institution_id: inst.id, professional_id: null, login: 'consultoria', display_name: 'Administrador da consultoria (demonstração)', password_hash: await hashPassword(password), scope_all: true,
      password_changed_at: now, function_role: 'admin', professional_category: 'administrativo', status: 'ativo', permissions_changed_at: now, authorized_by_name: 'Carga de demonstração',
    }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('user_role').values({ user_id: user.id, institution_id: inst.id, role_code: 'admin' }).execute();
    await audit(trx, { institutionId: inst.id, userId: null, login: 'seed', ip: null, userAgent: null }, { action: 'seed', entity: 'institution', entityId: inst.id, context: { origin: 'demo', organizationType: 'consultoria', users: 1 } });
    return { institutionId: inst.id, credentials: [{ login: 'consultoria', role: 'admin' as RoleCode, password }] };
  });
}
