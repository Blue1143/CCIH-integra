import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, assignableRoles } from './permissions';
import { MODEL_PERMISSIONS, SHARED_PERMISSIONS, cnpjProblem, effectivePermissions, formatCnpj, rolesOfModel } from './organization';

describe('organization model', () => {
  it('keeps every current permission in the hospital model', () => {
    expect(MODEL_PERMISSIONS.hospitalar).toEqual(ALL_PERMISSIONS.filter((p) => !p.startsWith('consultoria:')));
    for (const perms of Object.values(DEFAULT_ROLE_PERMISSIONS)) expect(effectivePermissions(perms, 'hospitalar')).toEqual(perms);
  });

  it('limits the consulting model to shared and consulting permissions', () => {
    expect(effectivePermissions(DEFAULT_ROLE_PERMISSIONS.enf_ccih, 'consultoria').every((p) => SHARED_PERMISSIONS.includes(p))).toBe(true);
    expect(effectivePermissions(DEFAULT_ROLE_PERMISSIONS.admin, 'consultoria')).toEqual(expect.arrayContaining(['users:manage', 'audit:view', 'alerts:view']));
    expect(effectivePermissions(DEFAULT_ROLE_PERMISSIONS.admin, 'consultoria')).not.toContain('patient:view');
  });

  it('assigns only the profiles of the organization model', () => {
    expect(rolesOfModel('consultoria')).toEqual(['admin']);
    expect(assignableRoles({ permissions: ['users:manage'], isFounder: true, organizationType: 'consultoria' })).toEqual(['admin']);
    expect(assignableRoles({ permissions: ['users:manage'], isFounder: false })).toContain('enf_ccih');
  });

  it('validates CNPJ check digits', () => {
    expect(cnpjProblem('11.222.333/0001-81')).toBeNull();
    expect(cnpjProblem('11.222.333/0001-80')).toMatch(/verificadores/);
    expect(cnpjProblem('11111111111111')).toMatch(/inválido/);
    expect(cnpjProblem('123')).toMatch(/14 dígitos/);
    expect(formatCnpj('11222333000181')).toBe('11.222.333/0001-81');
  });
});
