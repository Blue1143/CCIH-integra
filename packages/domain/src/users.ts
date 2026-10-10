import {
  APPRENTICE_ALLOWED, ROLE_LABEL, assignableRoles, canManageAccount, grantablePermissions, isPermission,
  type Grantor, type Permission, type RoleCode,
} from './permissions';

export type AccountStatus = 'pendente' | 'ativo' | 'suspenso' | 'desativado';
export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = { pendente: 'Pendente de autorização', ativo: 'Ativa', suspenso: 'Suspensa', desativado: 'Desativada' };

export type ProfessionalCategory = 'enfermeiro' | 'tecnico_enfermagem' | 'medico' | 'administrativo' | 'aprendiz' | 'outro';
export const PROFESSIONAL_CATEGORY_LABEL: Record<ProfessionalCategory, string> = {
  enfermeiro: 'Enfermeiro(a)', tecnico_enfermagem: 'Técnico(a) de enfermagem', medico: 'Médico(a)', administrativo: 'Administrativo', aprendiz: 'Jovem aprendiz', outro: 'Outra',
};

export interface UserGrantDto { id: string; permission: Permission; grantedByName: string; justification: string; validUntil: string | null; createdAt: string }

export interface UserAccountDto {
  id: string; login: string; displayName: string; email: string | null; registration: string | null; category: ProfessionalCategory | null;
  functionRole: RoleCode | null; roles: RoleCode[]; status: AccountStatus; statusReason: string | null; scopeAll: boolean; sectorIds: string[];
  isFounder: boolean; createdAt: string; createdByName: string | null; authorizedByName: string | null; permissionsChangedAt: string | null;
  validFrom: string | null; validUntil: string | null; supervisorId: string | null; supervisorName: string | null;
  lockedUntil: string | null; lastLoginAt: string | null; grants: UserGrantDto[];
  /** Whether the signed-in manager may change this account (the API decides the same way). */
  manageable: boolean; rowVersion: number;
}

export interface UserHistoryEntry { id: string; at: string; by: string | null; action: string; entity: string; before: unknown; after: unknown; justification: string | null }

/** What a manager submits for an account (creation adds the login). */
export interface UserAccessInput {
  displayName: string; email: string | null; registration: string | null; category: ProfessionalCategory | null;
  functionRole: RoleCode; extraRoles: RoleCode[]; scopeAll: boolean; sectorIds: string[]; status: AccountStatus; statusReason: string | null;
  validFrom: string | null; validUntil: string | null; supervisorId: string | null;
  grants: Array<{ permission: string; validUntil: string | null }>; justification: string;
}

export interface FieldProblem { path: string; message: string }

/**
 * Rules for giving or changing access, shared by the API (which enforces them) and the screen
 * (which explains them before sending). The grantor is the signed-in manager.
 */
export function checkAccess(input: UserAccessInput, grantor: Grantor, today: string): FieldProblem[] {
  const p: FieldProblem[] = [];
  const roles = [...new Set([input.functionRole, ...input.extraRoles])];
  const allowed = assignableRoles(grantor);
  if (!input.functionRole) p.push({ path: 'functionRole', message: 'Informe a função no sistema.' });
  for (const r of roles) if (!allowed.includes(r)) p.push({ path: r === input.functionRole ? 'functionRole' : 'extraRoles', message: `Seu perfil não pode atribuir a função ${ROLE_LABEL[r] ?? r}.` });
  if (input.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) p.push({ path: 'email', message: 'E-mail inválido.' });
  if (!input.scopeAll && !input.sectorIds.length) p.push({ path: 'sectorIds', message: 'Informe o setor de atuação (ou acesso a todos os setores).' });
  if (input.validFrom && input.validUntil && input.validUntil < input.validFrom) p.push({ path: 'validUntil', message: 'A validade termina antes de começar.' });
  if ((input.status === 'suspenso' || input.status === 'desativado') && !input.statusReason?.trim()) p.push({ path: 'statusReason', message: 'Informe o motivo da suspensão ou desativação.' });
  if (input.justification.trim().length < 10) p.push({ path: 'justification', message: 'Descreva o motivo (mínimo 10 caracteres).' });

  const grantable = grantablePermissions(grantor, roles);
  const seen = new Set<string>();
  for (const g of input.grants) {
    if (!isPermission(g.permission) || !grantable.includes(g.permission)) p.push({ path: 'grants', message: `Permissão não pode ser concedida por você a esta função: ${g.permission}.` });
    if (seen.has(g.permission)) p.push({ path: 'grants', message: `Permissão repetida: ${g.permission}.` });
    seen.add(g.permission);
    if (g.validUntil && g.validUntil < today) p.push({ path: 'grants', message: `A concessão ${g.permission} já está vencida.` });
  }

  if (roles.includes('aprendiz')) {
    if (roles.length > 1) p.push({ path: 'extraRoles', message: 'O Jovem Aprendiz não acumula outras funções.' });
    if (input.grants.some((g) => !APPRENTICE_ALLOWED.includes(g.permission as Permission))) p.push({ path: 'grants', message: 'Permissão fora da lista permitida ao Jovem Aprendiz.' });
    if (input.status === 'ativo') {
      if (!input.grants.length) p.push({ path: 'grants', message: 'Defina as permissões do Jovem Aprendiz antes de ativar a conta.' });
      if (!input.supervisorId) p.push({ path: 'supervisorId', message: 'Informe o responsável pela supervisão.' });
      if (!input.validUntil) p.push({ path: 'validUntil', message: 'Informe a data de expiração ou revisão do acesso.' });
    }
  }
  return p;
}

/** The API's own guard for changing an existing account (self-changes are never allowed). */
export function accountChangeRefusal(grantor: Grantor & { userId: string }, target: { id: string; roles: RoleCode[]; isFounder: boolean }): string | null {
  if (target.id === grantor.userId) return 'Ninguém altera o próprio acesso: peça a outro gestor autorizado.';
  if (target.isFounder) return 'A conta criadora só é alterada por ela mesma, em "Minha conta".';
  if (!canManageAccount(grantor, target)) return target.roles.includes('admin') ? 'Somente a conta criadora altera Administradores do sistema.' : 'Esta conta tem funções fora do seu módulo.';
  return null;
}
