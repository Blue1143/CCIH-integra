import type { Kysely } from 'kysely';
import { DEFAULT_ROLE_PERMISSIONS, ROLE_LABEL, ROLE_MODULE, cnpjProblem, normalizeCnpj, rolesOfModel, type OrganizationType } from '@ccih/domain';
import type { DB } from '../db/types';
import { audit } from '../audit/audit';
import { createFounder, founderProblem, type FounderResult } from './founder';

export interface OrganizationInput {
  type: OrganizationType;
  name: string;
  legalName?: string | null;
  cnpj?: string | null;
  timezone?: string;
  founder: { login: string; password: string; displayName: string };
}

/**
 * Creates an organization of one business model with only the profiles of that model, then its
 * creator account. Run by the platform operator on the server (no screen creates organizations).
 * Real organizations start empty: no demonstration data is copied into them.
 */
export async function createOrganization(db: Kysely<DB>, input: OrganizationInput): Promise<{ institutionId: string; founder: FounderResult }> {
  const name = input.name.trim();
  const founderIssue = founderProblem(input.founder);
  if (founderIssue) throw new Error(founderIssue);
  if (name.length < 3) throw new Error('Informe o nome da organização (mínimo 3 caracteres).');
  const cnpj = input.cnpj ? normalizeCnpj(input.cnpj) : null;
  if (cnpj) {
    const problem = cnpjProblem(cnpj);
    if (problem) throw new Error(problem);
    if (await db.selectFrom('institution').select('id').where('cnpj', '=', cnpj).executeTakeFirst()) throw new Error('Já existe uma organização com este CNPJ.');
  }
  const timezone = input.timezone ?? 'America/Sao_Paulo';
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: timezone });
  } catch {
    throw new Error(`Fuso horário inválido: ${timezone}`);
  }
  if (await db.selectFrom('app_user').select('id').where('login', '=', input.founder.login.trim().toLowerCase()).executeTakeFirst()) throw new Error('Este login já está em uso.');
  const institutionId = await db.transaction().execute(async (trx) => {
    const inst = await trx.insertInto('institution').values({ name, legal_name: input.legalName?.trim() || null, cnpj, cnes: null, timezone, data_origin: 'real', organization_type: input.type }).returning('id').executeTakeFirstOrThrow();
    for (const code of rolesOfModel(input.type)) {
      await trx.insertInto('role').values({ institution_id: inst.id, code, name: ROLE_LABEL[code], permissions: DEFAULT_ROLE_PERMISSIONS[code], module: ROLE_MODULE[code] }).execute();
    }
    await audit(trx, { institutionId: inst.id, userId: null, login: 'operador', ip: null, userAgent: 'org:create' }, {
      action: 'create', entity: 'institution', entityId: inst.id, after: { name, organizationType: input.type, cnpj, timezone }, context: { justification: 'Criação da organização pelo comando do operador da plataforma.' },
    });
    return inst.id;
  });
  const founder = await createFounder(db, { ...input.founder, institutionId });
  return { institutionId, founder };
}
