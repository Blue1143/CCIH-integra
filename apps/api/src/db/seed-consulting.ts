import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { DEFAULT_ROLE_PERMISSIONS, addDays, effectivePermissions, ROLE_LABEL, ROLE_MODULE, rolesOfModel, shiftMonths, todayIn, type RoleCode } from '@ccih/domain';
import { audit } from '../audit/audit';
import { hashPassword } from '../security/crypto';
import type { DB } from './types';

/**
 * Synthetic consulting organization for demonstration and end-to-end tests (flagged data_origin =
 * 'demo'): a small team and three synthetic clients, so the portfolio screens can be seen. Modules
 * that produce results (audits, indicators, reports) are never filled with invented data.
 */
export async function seedDemoConsulting(db: Kysely<DB>, opts: { password?: string; now?: Date } = {}): Promise<{ institutionId: string; credentials: Array<{ login: string; role: RoleCode; password: string }> }> {
  const now = opts.now ?? new Date();
  return db.transaction().execute(async (trx) => {
    const inst = await trx.insertInto('institution').values({ name: 'Consultoria de demonstração', legal_name: null, cnpj: null, cnes: null, timezone: 'America/Sao_Paulo', data_origin: 'demo', organization_type: 'consultoria' }).returning('id').executeTakeFirstOrThrow();
    for (const code of rolesOfModel('consultoria')) {
      await trx.insertInto('role').values({ institution_id: inst.id, code, name: ROLE_LABEL[code], permissions: effectivePermissions(DEFAULT_ROLE_PERMISSIONS[code], 'consultoria'), module: ROLE_MODULE[code] }).execute();
    }
    const team: Array<{ login: string; name: string; role: RoleCode }> = [
      { login: 'consultoria', name: 'Administrador da consultoria (demonstração)', role: 'admin' },
      { login: 'gestor.consultoria', name: 'Gestora da consultoria (demonstração)', role: 'gestor_consultoria' },
      { login: 'consultor', name: 'Consultor CCIH (demonstração)', role: 'consultor' },
      { login: 'assistente.consultoria', name: 'Assistente administrativo (demonstração)', role: 'assistente_consultoria' },
      { login: 'financeiro.consultoria', name: 'Financeiro da consultoria (demonstração)', role: 'financeiro_consultoria' },
    ];
    const credentials: Array<{ login: string; role: RoleCode; password: string }> = [];
    const ids = new Map<string, string>();
    for (const m of team) {
      const password = opts.password ?? `${randomBytes(9).toString('base64url')}-Aa1!`;
      const user = await trx.insertInto('app_user').values({
        institution_id: inst.id, professional_id: null, login: m.login, display_name: m.name, password_hash: await hashPassword(password), scope_all: true,
        password_changed_at: now, function_role: m.role, professional_category: m.role === 'consultor' ? 'enfermeiro' : 'administrativo', status: 'ativo', permissions_changed_at: now, authorized_by_name: 'Carga de demonstração',
      }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('user_role').values({ user_id: user.id, institution_id: inst.id, role_code: m.role }).execute();
      ids.set(m.login, user.id);
      credentials.push({ login: m.login, role: m.role, password });
    }
    // Synthetic clients (flagged as demonstration): the portfolio screens have something to show; no results are invented.
    const today = todayIn('America/Sao_Paulo', now);
    const clients = [
      { legal: 'Hospital Exemplo Norte Ltda (demonstração)', trade: 'Hospital Exemplo Norte', kind: 'hospital', city: 'Campinas', beds: 180, units: [['UTI Adulto', 'uti_adulto', 20], ['Centro Cirúrgico', 'centro_cirurgico', null], ['CME', 'cme', null]], consultant: true },
      { legal: 'Clínica Exemplo Sul S/A (demonstração)', trade: 'Clínica Exemplo Sul', kind: 'clinica', city: 'Sorocaba', beds: 30, units: [['Internação', 'internacao', 30]], consultant: true },
      { legal: 'Policlínica Exemplo Leste (demonstração)', trade: 'Policlínica Exemplo Leste', kind: 'ambulatorio', city: 'Jundiaí', beds: null, units: [], consultant: false },
    ] as const;
    const clientIds: string[] = [];
    for (const c of clients) {
      const client = await trx.insertInto('client').values({
        institution_id: inst.id, legal_name: c.legal, trade_name: c.trade, cnpj: null, kind: c.kind, status: 'ativo', email: null, phone: null, street: null, number: null, district: null,
        city: c.city, state: 'SP', zip: null, services_summary: 'Demonstração: sem contrato real.', internal_notes: null, created_by: ids.get('gestor.consultoria')!, created_by_name: 'Carga de demonstração', data_origin: 'demo',
      }).returning('id').executeTakeFirstOrThrow();
      clientIds.push(client.id);
      const est = await trx.insertInto('client_establishment').values({
        institution_id: inst.id, client_id: client.id, name: `${c.trade} — unidade principal`, cnes: null, cnpj: null, kind: c.kind, beds: c.beds, street: null, number: null, district: null, city: c.city, state: 'SP', zip: null,
      }).returning('id').executeTakeFirstOrThrow();
      for (const [name, kind, beds] of c.units) await trx.insertInto('client_unit').values({ institution_id: inst.id, establishment_id: est.id, name, kind, beds }).execute();
      await trx.insertInto('client_event').values({ institution_id: inst.id, client_id: client.id, kind: 'cadastro', summary: 'Cliente cadastrado (carga de demonstração).', detail: null, occurred_on: today, actor_id: null, actor_name: 'Carga de demonstração' }).execute();
      if (c.consultant) {
        await trx.insertInto('client_assignment').values({ institution_id: inst.id, client_id: client.id, user_id: ids.get('consultor')!, role: 'responsavel', specialty: 'ccih', starts_on: today, assigned_by: null, assigned_by_name: 'Carga de demonstração', reason: 'Distribuição inicial (demonstração)' }).execute();
      }
    }
    // Synthetic contracts: one signed (ending soon, so the expiry alert can be seen) and one proposal. No financial terms are invented.
    const year = today.slice(0, 4);
    const startsOn = shiftMonths(today, -4);
    const signed = await trx.insertInto('contract').values({
      institution_id: inst.id, client_id: clientIds[0]!, code: `CT-${year}-001`, title: 'Assessoria em CCIH e CME (demonstração)', status: 'vigente', starts_on: startsOn, ends_on: addDays(today, 45),
      auto_renew: false, renewal_notice_days: 60, responsible_id: ids.get('gestor.consultoria')!, scope_notes: 'Contrato sintético para demonstração.', signed_on: addDays(startsOn, -5),
      created_by: ids.get('gestor.consultoria')!, created_by_name: 'Carga de demonstração', data_origin: 'demo',
    }).returning('id').executeTakeFirstOrThrow();
    const visits = await trx.insertInto('contract_service').values({
      institution_id: inst.id, contract_id: signed.id, area: 'ccih', kind: 'visita_tecnica', description: 'Visita técnica à CCIH', establishment_id: null, unit: 'visitas', quantity: 2, period: 'mensal', starts_on: startsOn, position: 0,
    }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('contract_service').values({
      institution_id: inst.id, contract_id: signed.id, area: 'cme', kind: 'documentacao', description: 'Revisão dos POPs da CME', establishment_id: null, unit: 'entregas', quantity: 1, period: 'contrato', starts_on: startsOn, position: 1,
    }).execute();
    for (const months of [0, 1, 2]) {
      await trx.insertInto('contract_delivery').values({
        institution_id: inst.id, service_id: visits.id, occurred_on: addDays(shiftMonths(startsOn, months), 3), quantity: months === 2 ? 1 : 2, description: 'Visita técnica (demonstração)',
        created_by: ids.get('consultor')!, created_by_name: 'Carga de demonstração',
      }).execute();
    }
    await trx.insertInto('client_event').values({ institution_id: inst.id, client_id: clientIds[0]!, kind: 'contrato', summary: `Contrato CT-${year}-001 assinado (carga de demonstração).`, detail: null, occurred_on: today, actor_id: null, actor_name: 'Carga de demonstração', contract_id: signed.id }).execute();
    const proposal = await trx.insertInto('contract').values({
      institution_id: inst.id, client_id: clientIds[1]!, code: `CT-${year}-002`, title: 'Diagnóstico situacional em controle de infecção (demonstração)', status: 'proposta', starts_on: null, ends_on: null,
      auto_renew: false, renewal_notice_days: 30, responsible_id: null, scope_notes: null, signed_on: null, created_by: ids.get('assistente.consultoria')!, created_by_name: 'Carga de demonstração', data_origin: 'demo',
    }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('contract_service').values({
      institution_id: inst.id, contract_id: proposal.id, area: 'ccih', kind: 'diagnostico', description: 'Diagnóstico situacional da CCIH', establishment_id: null, unit: 'entregas', quantity: 1, period: 'contrato', starts_on: null, position: 0,
    }).execute();
    await audit(trx, { institutionId: inst.id, userId: null, login: 'seed', ip: null, userAgent: null }, { action: 'seed', entity: 'institution', entityId: inst.id, context: { origin: 'demo', organizationType: 'consultoria', users: team.length, clients: clients.length, contracts: 2 } });
    return { institutionId: inst.id, credentials };
  });
}
