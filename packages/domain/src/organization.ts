import { ALL_PERMISSIONS, ROLE_MODELS, type Permission, type RoleCode } from './permissions';

/**
 * Business model of an organization, chosen when it is created and kept for its whole life:
 * - hospitalar: the internal operation of a healthcare facility (the complete current system);
 * - consultoria: a consulting company serving many client facilities.
 * The model decides which permissions can take effect: whatever a role or a grant says, a
 * permission outside the organization's model never reaches the session (enforced by the API).
 */
export type OrganizationType = 'hospitalar' | 'consultoria';
export const ORGANIZATION_TYPES: OrganizationType[] = ['hospitalar', 'consultoria'];
export const ORGANIZATION_TYPE_LABEL: Record<OrganizationType, string> = {
  hospitalar: 'CCIH Integra Hospitalar',
  consultoria: 'CCIH Integra Consultorias',
};
export const ORGANIZATION_TYPE_HINT: Record<OrganizationType, string> = {
  hospitalar: 'Hospital ou estabelecimento de saúde: operação interna completa (CCIH, CME, qualidade, indicadores, auditorias).',
  consultoria: 'Empresa de consultoria: carteira de clientes, contratos, agenda, equipe, auditorias, relatórios e área do cliente.',
};

/** Permissions every model shares: access administration, audit log and the alert center. */
export const SHARED_PERMISSIONS: Permission[] = ['users:view', 'users:manage', 'audit:view', 'alerts:view', 'alerts:manage'];

/** Permissions that exist only in the consulting model (filled as its modules are delivered). */
export const CONSULTING_PERMISSIONS: Permission[] = ALL_PERMISSIONS.filter((p) => p.startsWith('consultoria:'));

export const MODEL_PERMISSIONS: Record<OrganizationType, Permission[]> = {
  // The hospital model keeps every permission it has today.
  hospitalar: ALL_PERMISSIONS.filter((p) => !p.startsWith('consultoria:')),
  consultoria: [...SHARED_PERMISSIONS, ...CONSULTING_PERMISSIONS],
};

export const permissionInModel = (p: Permission, type: OrganizationType) => MODEL_PERMISSIONS[type].includes(p);

/** What actually reaches the session: the user's permissions limited to the organization's model. */
export const effectivePermissions = (permissions: Permission[], type: OrganizationType): Permission[] => permissions.filter((p) => permissionInModel(p, type));

export const rolesOfModel = (type: OrganizationType): RoleCode[] => (Object.keys(ROLE_MODELS) as RoleCode[]).filter((r) => ROLE_MODELS[r].includes(type));

export const isOrganizationType = (v: unknown): v is OrganizationType => typeof v === 'string' && (ORGANIZATION_TYPES as string[]).includes(v);

/** CNPJ check digits (Receita Federal algorithm); accepts digits only or the usual mask. */
export function cnpjProblem(raw: string): string | null {
  const d = raw.replace(/[.\-/\s]/g, '');
  if (!/^\d{14}$/.test(d)) return 'CNPJ deve ter 14 dígitos.';
  if (/^(\d)\1{13}$/.test(d)) return 'CNPJ inválido.';
  const digit = (len: number) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((acc, w, i) => acc + w * Number(d[i]), 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return digit(12) === Number(d[12]) && digit(13) === Number(d[13]) ? null : 'CNPJ inválido (dígitos verificadores).';
}
export const normalizeCnpj = (raw: string) => raw.replace(/[.\-/\s]/g, '');
export const formatCnpj = (d: string) => (d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : d);
