import { describe, expect, it } from 'vitest';
import {
  APPRENTICE_ALLOWED, APPRENTICE_AREAS, DEFAULT_ROLE_PERMISSIONS, DELEGABLE, FUNCTION_ROLES, NEVER_GRANTED_INDIVIDUALLY, ROLE_MODULE,
  apprenticeMarkerPermissions, apprenticeMarkersOf, assignableRoles, canManageAccount, grantableApprenticeAreas, grantablePermissions, type Permission, type RoleCode,
} from './permissions';

const can = (r: RoleCode, p: Permission) => DEFAULT_ROLE_PERMISSIONS[r].includes(p);
const CME_WRITE: Permission[] = ['cme:scan', 'cme:cycle:record', 'cme:test:record', 'cme:release', 'cme:override', 'cme:configure', 'cme:stations:configure', 'cme:parameters:edit'];
const ADMIN: Permission[] = ['users:manage', 'users:manage:ccih', 'users:manage:cme', 'config:rules:edit', 'config:org:edit'];

describe('function matrix', () => {
  it('offers the nine functions with a module each', () => {
    expect(FUNCTION_ROLES).toHaveLength(9);
    expect(FUNCTION_ROLES.every((r) => ROLE_MODULE[r])).toBe(true);
  });

  it('CCIH nurse and technician read the CME but never change it', () => {
    for (const r of ['enf_ccih', 'tec_ccih'] as const) {
      expect(can(r, 'cme:view')).toBe(true);
      expect(CME_WRITE.filter((p) => can(r, p))).toEqual([]);
    }
    // Same reach for viewing, not the same acts.
    expect(can('tec_ccih', 'iras:decide')).toBe(false);
    expect(can('tec_ccih', 'patient:view_identified')).toBe(false);
    expect(can('enf_ccih', 'quality:bundle:record') && can('enf_ccih', 'quality:training:edit') && can('enf_ccih', 'quality:supplies:edit')).toBe(true);
  });

  it('CME nurse runs the CME only; CME technician records but does not release, configure or grant exceptions', () => {
    expect(can('cme', 'cme:release')).toBe(true);
    expect(['dashboard:view', 'patient:view', 'iras:view', 'quality:audit:manage', 'config:rules:edit'].some((p) => can('cme', p as Permission))).toBe(false);
    expect(['cme:scan', 'cme:cycle:record', 'cme:test:record', 'nc:record'].every((p) => can('tec_cme', p as Permission))).toBe(true);
    expect(['cme:release', 'cme:configure', 'cme:override', 'cme:parameters:edit', 'config:targets:edit'].some((p) => can('tec_cme', p as Permission))).toBe(false);
  });

  it('Quality audits without touching CME, clinical records or global targets; the technician does not conduct or close', () => {
    for (const r of ['enf_qualidade', 'tec_qualidade'] as const) {
      expect([...CME_WRITE, 'cme:view', 'patient:edit', 'iras:edit', 'iras:view', 'config:targets:edit', ...ADMIN].some((p) => can(r, p as Permission))).toBe(false);
      expect(can(r, 'quality:audit:execute')).toBe(true);
    }
    expect(can('enf_qualidade', 'quality:audit:manage')).toBe(true);
    expect(can('tec_qualidade', 'quality:audit:manage')).toBe(false);
  });

  it('module administrators administer only their module', () => {
    expect(can('adm_cme', 'users:manage:cme') && can('adm_cme', 'cme:parameters:edit')).toBe(true);
    expect(['users:manage', 'users:manage:ccih', 'ccih:parameters:edit', 'config:targets:edit', 'iras:edit', 'audit:view'].some((p) => can('adm_cme', p as Permission))).toBe(false);
    expect(can('adm_ccih', 'users:manage:ccih') && can('adm_ccih', 'ccih:parameters:edit')).toBe(true);
    expect(['users:manage', 'users:manage:cme', 'cme:parameters:edit', ...CME_WRITE, 'audit:view'].some((p) => can('adm_ccih', p as Permission))).toBe(false);
  });

  it('the apprentice starts with nothing', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.aprendiz).toEqual([]);
  });
});

describe('delegation', () => {
  const founder = { permissions: DEFAULT_ROLE_PERMISSIONS.admin, isFounder: true };
  const admin = { permissions: DEFAULT_ROLE_PERMISSIONS.admin, isFounder: false };
  const admCme = { permissions: DEFAULT_ROLE_PERMISSIONS.adm_cme, isFounder: false };
  const admCcih = { permissions: DEFAULT_ROLE_PERMISSIONS.adm_ccih, isFounder: false };
  const nurse = { permissions: DEFAULT_ROLE_PERMISSIONS.cme, isFounder: false };

  it('only the creator account gives or changes the system administrator function', () => {
    expect(assignableRoles(founder)).toContain('admin');
    expect(assignableRoles(admin)).not.toContain('admin');
    expect(canManageAccount(admin, { roles: ['admin'], isFounder: false })).toBe(false);
    expect(canManageAccount(founder, { roles: ['admin'], isFounder: false })).toBe(true);
    expect(canManageAccount(founder, { roles: ['admin'], isFounder: true })).toBe(false);
  });

  it('module administrators give their own operational functions and the apprentice, never another administrator', () => {
    expect(assignableRoles(admCme).sort()).toEqual(['aprendiz', 'cme', 'tec_cme']);
    expect(assignableRoles(admCcih).sort()).toEqual(['aprendiz', 'enf_ccih', 'tec_ccih']);
    expect(canManageAccount(admCme, { roles: ['tec_cme'], isFounder: false })).toBe(true);
    expect(canManageAccount(admCme, { roles: ['enf_ccih'], isFounder: false })).toBe(false);
    expect(canManageAccount(admCme, { roles: ['adm_cme'], isFounder: false })).toBe(false);
    expect(canManageAccount(admCme, { roles: ['tec_cme', 'enf_qualidade'], isFounder: false })).toBe(false);
    expect(assignableRoles(nurse)).toEqual([]);
  });

  it('grants stay inside the grantor module and never include administration or identified data', () => {
    expect(grantablePermissions(admCme, ['tec_cme'])).toContain('cme:release');
    expect(grantablePermissions(admCme, ['tec_cme']).every((p) => DELEGABLE.cme.includes(p))).toBe(true);
    expect(grantablePermissions(admCcih, ['tec_ccih'])).not.toContain('cme:release');
    expect(grantablePermissions(admin, ['tec_qualidade']).some((p) => NEVER_GRANTED_INDIVIDUALLY.includes(p))).toBe(false);
    expect(grantablePermissions(admin, ['enf_qualidade'])).toContain('cme:view');
  });

  it('the apprentice receives only from the allowed list, and module administrators only their module packages', () => {
    const list = grantablePermissions(admin, ['aprendiz']);
    expect(list.every((p) => APPRENTICE_ALLOWED.includes(p))).toBe(true);
    expect(list).not.toContain('cme:release');
    for (const area of Object.values(APPRENTICE_AREAS)) for (const level of Object.values(area.levels)) expect(level!.permissions.every((p) => APPRENTICE_ALLOWED.includes(p))).toBe(true);
    expect(grantableApprenticeAreas(admCme).sort()).toEqual(['alertas', 'cme']);
    expect(grantableApprenticeAreas(admCcih).sort()).toEqual(['alertas', 'ccih', 'indicadores']);
    expect(grantableApprenticeAreas(admin)).toHaveLength(5);
  });

  it('turns each area marker into permissions; recording includes consulting the same area, never critical acts', () => {
    expect(apprenticeMarkerPermissions('cme', 'consulta')).toEqual(['cme:view']);
    expect(apprenticeMarkerPermissions('cme', 'registro').sort()).toEqual(['cme:scan', 'cme:view', 'nc:record']);
    expect(apprenticeMarkerPermissions('indicadores', 'exportacao')).toContain('indicators:view');
    const all = Object.keys(APPRENTICE_AREAS).flatMap((a) => (['consulta', 'registro', 'exportacao'] as const).flatMap((l) => apprenticeMarkerPermissions(a as 'cme', l)));
    expect(all.some((p) => ['cme:release', 'cme:cycle:record', 'iras:decide', 'patient:view_identified', 'users:manage'].includes(p))).toBe(false);
    expect(apprenticeMarkersOf(['cme:view', 'cme:scan', 'nc:record'])).toEqual([['cme', 'consulta'], ['cme', 'registro']]);
  });
});
