import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../db/types';
import type { AuthContext } from '../http/auth';
import { publish } from '../realtime/outbox';

type Trx = Transaction<DB> | Kysely<DB>;

/** Personal notification for one user (kept forever; only marked as read). Repeating it is a no-op. */
export async function notifyUser(trx: Trx, n: { institutionId: string; userId: string; kind: 'nao_conformidade'; title: string; detail: string; entity: string; entityId: string; link: string | null; origin: 'real' | 'demo' }) {
  await trx.insertInto('user_notification').values({
    institution_id: n.institutionId, user_id: n.userId, kind: n.kind, title: n.title, detail: n.detail, entity: n.entity, entity_id: n.entityId, link: n.link, data_origin: n.origin, read_at: null,
  }).onConflict((oc) => oc.columns(['user_id', 'entity', 'entity_id', 'kind']).doNothing()).execute();
  await publish(trx, { institutionId: n.institutionId, topic: 'notificacoes', permission: null, userId: n.userId });
}

/**
 * Institutional rule (09/10/2026): a package used without a registered CME exit is not blocked. The use
 * opens a non-conformity linked to the use and to the user who recorded it, and that user is notified.
 * Runs inside the transaction that records the use. No patient data goes into the text.
 */
export async function openUseWithoutExitNc(trx: Transaction<DB>, auth: AuthContext, u: { useId: string; labelCode: string; description: string; sectorId: string; sectorName: string; usedOn: string; origin: 'real' | 'demo' }) {
  const description = `Pacote ${u.labelCode} (${u.description}) usado em ${u.sectorName} em ${u.usedOn.split('-').reverse().join('/')} sem saída registrada do CME. Uso registrado por ${auth.displayName} (${auth.login}).`;
  const nc = await trx.insertInto('nonconformity').values({
    institution_id: auth.institutionId, audit_id: null, sector_id: u.sectorId, origin: 'cme', severity: 'media', description, detected_on: u.usedOn, status: 'aberta', effectiveness: null,
    data_origin: u.origin, created_by: null, updated_at: new Date(), notified_user_id: auth.userId, notified_user_name: auth.displayName, source_entity: 'material_use', source_id: u.useId,
  }).returningAll().executeTakeFirstOrThrow();
  await trx.insertInto('nonconformity_status').values({ nonconformity_id: nc.id, from_status: null, to_status: 'aberta', justification: 'Aberta automaticamente: uso de pacote sem saída registrada do CME.', decided_by: null, decided_by_name: 'Sistema (regra de saída da CME)', at: new Date() }).execute();
  await notifyUser(trx, {
    institutionId: auth.institutionId, userId: auth.userId, kind: 'nao_conformidade', title: 'Não conformidade: uso sem saída registrada do CME',
    detail: `${description} Confira com a CME a saída do pacote antes do próximo uso.`, entity: 'nonconformity', entityId: nc.id, link: `/auditorias/nao-conformidades/${nc.id}`, origin: u.origin,
  });
  return nc;
}
