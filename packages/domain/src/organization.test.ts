import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, assignableRoles, grantablePermissions } from './permissions';
import { MODEL_PERMISSIONS, SHARED_PERMISSIONS, cnpjProblem, effectivePermissions, formatCnpj, rolesOfModel } from './organization';

describe('organization model', () => {
  it('keeps every current permission in the hospital model', () => {
    expect(MODEL_PERMISSIONS.hospitalar).toEqual(ALL_PERMISSIONS.filter((p) => !p.startsWith('consultoria:')));
    for (const role of rolesOfModel('hospitalar')) {
      const perms = DEFAULT_ROLE_PERMISSIONS[role];
      expect(effectivePermissions(perms, 'hospitalar')).toEqual(perms.filter((p) => !p.startsWith('consultoria:')));
    }
    // Hospital profiles never carry consulting permissions (only the administrator's "all" list does, and it is cut).
    for (const role of rolesOfModel('hospitalar').filter((r) => r !== 'admin')) expect(DEFAULT_ROLE_PERMISSIONS[role].some((p) => p.startsWith('consultoria:'))).toBe(false);
  });

  it('limits the consulting model to shared and consulting permissions', () => {
    expect(effectivePermissions(DEFAULT_ROLE_PERMISSIONS.enf_ccih, 'consultoria').every((p) => SHARED_PERMISSIONS.includes(p))).toBe(true);
    expect(effectivePermissions(DEFAULT_ROLE_PERMISSIONS.admin, 'consultoria')).toEqual(expect.arrayContaining(['users:manage', 'audit:view', 'alerts:view']));
    expect(effectivePermissions(DEFAULT_ROLE_PERMISSIONS.admin, 'consultoria')).not.toContain('patient:view');
  });

  it('assigns only the profiles of the organization model', () => {
    expect(rolesOfModel('consultoria')).toEqual(['admin', 'gestor_consultoria', 'consultor', 'assistente_consultoria', 'financeiro_consultoria']);
    expect(assignableRoles({ permissions: ['users:manage'], isFounder: true, organizationType: 'consultoria' })).toEqual(rolesOfModel('consultoria'));
    expect(assignableRoles({ permissions: ['users:manage'], isFounder: false, organizationType: 'consultoria' })).not.toContain('admin');
    expect(assignableRoles({ permissions: ['users:manage'], isFounder: false, organizationType: 'consultoria' })).not.toContain('enf_ccih');
    expect(assignableRoles({ permissions: ['users:manage'], isFounder: false })).toContain('enf_ccih');
  });

  it('gives consulting profiles only consulting and shared permissions, and keeps assignment and notes away from consultants', () => {
    for (const role of rolesOfModel('consultoria')) expect(effectivePermissions(DEFAULT_ROLE_PERMISSIONS[role], 'consultoria')).toEqual(DEFAULT_ROLE_PERMISSIONS[role].filter((p) => MODEL_PERMISSIONS.consultoria.includes(p)));
    for (const role of rolesOfModel('consultoria').filter((r) => r !== 'admin')) expect(DEFAULT_ROLE_PERMISSIONS[role].every((p) => MODEL_PERMISSIONS.consultoria.includes(p))).toBe(true);
    expect(DEFAULT_ROLE_PERMISSIONS.consultor).not.toContain('consultoria:portfolio:all');
    expect(DEFAULT_ROLE_PERMISSIONS.consultor).not.toContain('consultoria:clients:internal_notes');
    expect(grantablePermissions({ permissions: ['users:manage'], isFounder: true, organizationType: 'consultoria' }, ['consultor']).every((p) => MODEL_PERMISSIONS.consultoria.includes(p))).toBe(true);
    expect(grantablePermissions({ permissions: ['users:manage'], isFounder: true, organizationType: 'consultoria' }, ['consultor'])).not.toContain('consultoria:portfolio:assign');
  });

  it('validates CNPJ check digits', () => {
    expect(cnpjProblem('11.222.333/0001-81')).toBeNull();
    expect(cnpjProblem('11.222.333/0001-80')).toMatch(/verificadores/);
    expect(cnpjProblem('11111111111111')).toMatch(/inválido/);
    expect(cnpjProblem('123')).toMatch(/14 dígitos/);
    expect(formatCnpj('11222333000181')).toBe('11.222.333/0001-81');
  });
});
