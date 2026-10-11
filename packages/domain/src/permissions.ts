/**
 * Granular permissions and the default matrix of the initial profiles. The API enforces them on
 * every request; the UI only uses them to hide what the user cannot do.
 */
export const PERMISSIONS = {
  'dashboard:view': 'Ver painel executivo',
  'indicators:view': 'Ver catálogo e valores de indicadores',
  'indicators:consolidate': 'Consolidar indicadores a partir dos registros clínicos',
  'reports:view': 'Ver e gerar relatórios',
  'config:view': 'Ver configurações, referências e parâmetros',
  'config:targets:edit': 'Editar metas de indicadores',
  'config:rules:edit': 'Editar parâmetros de regras institucionais (todos os módulos)',
  'config:references:edit': 'Cadastrar e editar referências clínicas e regulatórias',
  'config:references:validate': 'Validar referências clínicas e regulatórias',
  'config:org:edit': 'Editar instituição, unidades e setores',
  'config:cme_policy:edit': 'Editar a política de liberação de cargas da CME',
  'ccih:parameters:edit': 'Editar parâmetros institucionais da CCIH (dispositivos, internação, cirurgia, antimicrobianos, alertas)',
  'cme:parameters:edit': 'Editar parâmetros institucionais da CME',
  'users:view': 'Ver usuários e perfis',
  'users:manage': 'Gerenciar usuários, perfis e escopos (todos os módulos)',
  'users:manage:ccih': 'Gerenciar usuários e funções da CCIH',
  'users:manage:cme': 'Gerenciar usuários e funções da CME',
  'audit:view': 'Consultar o log de auditoria completo',
  'audit:view:module': 'Consultar o log de auditoria do próprio módulo',
  'patient:view': 'Ver pacientes (iniciais e prontuário)',
  'patient:view_identified': 'Ver dados identificados de pacientes',
  'patient:edit': 'Registrar pacientes, internações, movimentações, dispositivos e evoluções CCIH',
  'iras:view': 'Ver vigilância de IRAS',
  'iras:edit': 'Registrar suspeitas e investigações de IRAS',
  'iras:decide': 'Confirmar ou descartar IRAS',
  'surgery:view': 'Ver registro cirúrgico',
  'surgery:edit': 'Registrar cirurgias e antibioticoprofilaxia',
  'micro:view': 'Ver microbiologia',
  'micro:edit': 'Registrar culturas e perfis microbiológicos',
  'atm:view': 'Ver antimicrobianos',
  'atm:review': 'Registrar revisão de antimicrobianos',
  'cme:view': 'Ver CME e rastreabilidade (somente leitura)',
  'cme:scan': 'Registrar leituras nas estações da CME (entrada, processamento e saída)',
  'cme:cycle:record': 'Montar cargas, registrar ciclos e usos de material da CME',
  'cme:test:record': 'Registrar testes físicos, químicos, biológicos e Bowie-Dick',
  'cme:release': 'Liberar, reter ou rejeitar cargas',
  'cme:configure': 'Cadastrar equipamentos da CME e o catálogo de caixas',
  'cme:stations:configure': 'Cadastrar e parear estações de leitura e configurar o fluxo da CME',
  'cme:override': 'Autorizar exceção de sequência no fluxo da CME (com justificativa)',
  'quality:view': 'Ver bundles, auditorias, treinamentos e insumos',
  'quality:bundle:record': 'Registrar auditorias de bundle e observações de higiene das mãos',
  'quality:audit:execute': 'Registrar achados, evidências e andamento de ações de auditorias',
  'quality:audit:manage': 'Planejar, conduzir e concluir auditorias; tratar e encerrar não conformidades',
  'quality:training:edit': 'Registrar treinamentos e presenças',
  'quality:supplies:edit': 'Registrar insumos e movimentações de estoque',
  'quality:configure': 'Configurar modelos de bundle, catálogo de treinamentos e de insumos',
  'nc:record': 'Registrar não conformidades (sem tratá-las ou encerrá-las)',
  'alerts:view': 'Ver alertas',
  'alerts:manage': 'Reconhecer, assumir, resolver e encerrar alertas',
  'alerts:exception': 'Encerrar por exceção formal um alerta bloqueante cuja condição persiste',
  'export:aggregate': 'Exportar dados agregados',
  'export:identified': 'Exportar dados identificáveis',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/** Areas of the system. A module administrator never acts outside its module. */
export type AccessModule = 'ccih' | 'cme' | 'qualidade' | 'sistema';
export const MODULE_LABEL: Record<AccessModule, string> = { ccih: 'CCIH', cme: 'CME', qualidade: 'Qualidade', sistema: 'Sistema' };

/**
 * Functions (profiles). Codes are stable identifiers stored in the database; "cme" is the
 * Enfermeiro CME (it was the single CME profile before the functions were split).
 */
export type RoleCode =
  | 'admin' | 'enf_ccih' | 'tec_ccih' | 'cme' | 'tec_cme' | 'enf_qualidade' | 'tec_qualidade' | 'adm_cme' | 'adm_ccih' | 'aprendiz'
  | 'infectologista' | 'auditor' | 'gestor' | 'consulta';

export const ROLE_LABEL: Record<RoleCode, string> = {
  admin: 'Administrador do sistema',
  enf_ccih: 'Enfermeiro CCIH',
  tec_ccih: 'Técnico de Enfermagem CCIH',
  cme: 'Enfermeiro CME',
  tec_cme: 'Técnico de Enfermagem CME',
  enf_qualidade: 'Enfermeiro Qualidade',
  tec_qualidade: 'Técnico de Enfermagem Qualidade',
  adm_cme: 'ADM CME',
  adm_ccih: 'ADM CCIH',
  aprendiz: 'Jovem Aprendiz',
  infectologista: 'Médico infectologista',
  auditor: 'Auditor',
  gestor: 'Gestor',
  consulta: 'Consulta',
};

/** The functions offered in "Função no sistema", in this order (the other profiles stay available to administrators). */
export const FUNCTION_ROLES: RoleCode[] = ['enf_ccih', 'cme', 'enf_qualidade', 'tec_ccih', 'tec_cme', 'tec_qualidade', 'adm_cme', 'adm_ccih', 'aprendiz'];
export const ADDITIONAL_ROLES: RoleCode[] = ['infectologista', 'auditor', 'gestor', 'consulta'];

export const ROLE_MODULE: Record<RoleCode, AccessModule> = {
  admin: 'sistema', enf_ccih: 'ccih', tec_ccih: 'ccih', adm_ccih: 'ccih', cme: 'cme', tec_cme: 'cme', adm_cme: 'cme',
  enf_qualidade: 'qualidade', tec_qualidade: 'qualidade', aprendiz: 'sistema', infectologista: 'ccih', auditor: 'qualidade', gestor: 'sistema', consulta: 'sistema',
};

const VIEW_CORE: Permission[] = ['dashboard:view', 'indicators:view'];

const ENF_CCIH: Permission[] = [
  ...VIEW_CORE, 'reports:view', 'config:view', 'config:references:validate', 'indicators:consolidate',
  'patient:view', 'patient:view_identified', 'patient:edit', 'iras:view', 'iras:edit', 'iras:decide', 'surgery:view', 'surgery:edit',
  'micro:view', 'atm:view', 'cme:view', 'quality:view', 'quality:bundle:record', 'quality:training:edit', 'quality:supplies:edit', 'nc:record',
  'alerts:view', 'alerts:manage', 'alerts:exception', 'export:aggregate',
];
const ENF_CME: Permission[] = [
  'cme:view', 'cme:scan', 'cme:cycle:record', 'cme:test:record', 'cme:release', 'cme:override', 'cme:configure', 'cme:stations:configure',
  'nc:record', 'alerts:view', 'alerts:manage', 'reports:view',
];

/** Default permissions per function (least privilege). Institutions can adjust them in Administração. */
export const DEFAULT_ROLE_PERMISSIONS: Record<RoleCode, Permission[]> = {
  admin: ALL_PERMISSIONS,
  enf_ccih: ENF_CCIH,
  // Same reach for viewing; no IRAS decision, no identified data, no surgery editing, no alert exceptions.
  tec_ccih: [
    ...VIEW_CORE, 'reports:view', 'patient:view', 'patient:edit', 'iras:view', 'iras:edit', 'surgery:view', 'micro:view', 'atm:view',
    'cme:view', 'quality:view', 'nc:record', 'alerts:view',
  ],
  cme: ENF_CME,
  // Executes and records; never releases, configures or grants exceptions by default.
  tec_cme: ['cme:view', 'cme:scan', 'cme:cycle:record', 'cme:test:record', 'nc:record', 'alerts:view'],
  enf_qualidade: [
    ...VIEW_CORE, 'reports:view', 'config:view', 'quality:view', 'quality:audit:manage', 'quality:audit:execute', 'quality:bundle:record',
    'quality:training:edit', 'quality:supplies:edit', 'nc:record', 'alerts:view', 'alerts:manage', 'export:aggregate',
  ],
  tec_qualidade: [...VIEW_CORE, 'reports:view', 'quality:view', 'quality:audit:execute', 'quality:bundle:record', 'nc:record', 'alerts:view'],
  adm_cme: [...ENF_CME, 'config:view', 'cme:parameters:edit', 'config:cme_policy:edit', 'quality:training:edit', 'users:manage:cme', 'audit:view:module'],
  adm_ccih: [...ENF_CCIH, 'ccih:parameters:edit', 'config:targets:edit', 'config:references:edit', 'quality:configure', 'users:manage:ccih', 'audit:view:module'],
  // Only what the supervising manager grants individually.
  aprendiz: [],
  infectologista: [
    ...VIEW_CORE, 'reports:view', 'config:view', 'config:references:validate',
    'patient:view', 'patient:view_identified', 'iras:view', 'iras:edit', 'iras:decide', 'surgery:view',
    'micro:view', 'micro:edit', 'atm:view', 'atm:review', 'nc:record', 'alerts:view', 'alerts:manage', 'export:aggregate',
  ],
  auditor: [
    ...VIEW_CORE, 'reports:view', 'config:view', 'audit:view', 'users:view',
    'patient:view', 'iras:view', 'surgery:view', 'micro:view', 'atm:view', 'cme:view', 'quality:view', 'alerts:view',
  ],
  gestor: [...VIEW_CORE, 'reports:view', 'quality:view', 'export:aggregate'],
  consulta: [...VIEW_CORE],
};

/* ---------- Delegation: who may give what to whom ---------- */

/** Never granted individually: administration, global configuration, identified data and exports. */
export const NEVER_GRANTED_INDIVIDUALLY: Permission[] = [
  'users:view', 'users:manage', 'users:manage:ccih', 'users:manage:cme', 'audit:view', 'audit:view:module', 'config:targets:edit', 'config:rules:edit',
  'config:references:edit', 'config:org:edit', 'config:cme_policy:edit', 'ccih:parameters:edit', 'cme:parameters:edit', 'patient:view_identified',
  'export:identified', 'alerts:exception', 'quality:configure',
];

/** Permissions a module administrator may grant individually (express authorization, with justification and validity). */
export const DELEGABLE: Record<'ccih' | 'cme', Permission[]> = {
  cme: ['cme:view', 'cme:scan', 'cme:cycle:record', 'cme:test:record', 'cme:release', 'cme:override', 'nc:record', 'alerts:view', 'reports:view'],
  ccih: [
    'dashboard:view', 'indicators:view', 'reports:view', 'patient:view', 'iras:view', 'iras:edit', 'surgery:view', 'micro:view', 'atm:view', 'cme:view',
    'quality:view', 'quality:bundle:record', 'quality:audit:execute', 'nc:record', 'alerts:view', 'export:aggregate',
  ],
};

/** The Jovem Aprendiz only ever receives permissions from this list (no administration, release, decision or identified data). */
export const APPRENTICE_ALLOWED: Permission[] = [
  'dashboard:view', 'indicators:view', 'reports:view', 'patient:view', 'iras:view', 'surgery:view', 'micro:view', 'atm:view', 'cme:view', 'cme:scan',
  'quality:view', 'quality:bundle:record', 'quality:audit:execute', 'nc:record', 'alerts:view', 'export:aggregate',
];

/**
 * Jovem Aprendiz: markers per area and level, chosen by the supervising manager. "Registro/edição"
 * includes the consultation of the same area; nothing here allows administration, release of loads,
 * IRAS decisions, identified patient data or granting access to others.
 */
export type ApprenticeArea = 'ccih' | 'cme' | 'qualidade' | 'indicadores' | 'alertas';
export type ApprenticeLevel = 'consulta' | 'registro' | 'exportacao';
export const APPRENTICE_LEVEL_LABEL: Record<ApprenticeLevel, string> = { consulta: 'Consulta', registro: 'Registro/edição', exportacao: 'Exportação' };
export const APPRENTICE_AREAS: Record<ApprenticeArea, { label: string; module: 'ccih' | 'cme' | 'qualidade' | null; levels: Partial<Record<ApprenticeLevel, { hint: string; permissions: Permission[] }>> }> = {
  ccih: {
    label: 'CCIH — vigilância', module: 'ccih',
    levels: {
      consulta: { hint: 'Vigilância de IRAS, pacientes (iniciais e prontuário), cirurgias, microbiologia e antimicrobianos', permissions: ['iras:view', 'patient:view', 'surgery:view', 'micro:view', 'atm:view'] },
      registro: { hint: 'Checklists de bundle e higiene das mãos; registro de não conformidade', permissions: ['quality:view', 'quality:bundle:record', 'nc:record'] },
    },
  },
  cme: {
    label: 'CME', module: 'cme',
    levels: {
      consulta: { hint: 'Painel, cargas, processos e rastreabilidade (somente leitura)', permissions: ['cme:view'] },
      registro: { hint: 'Leituras nas estações (etapas do processamento); registro de não conformidade', permissions: ['cme:scan', 'nc:record'] },
    },
  },
  qualidade: {
    label: 'Qualidade — auditorias', module: 'qualidade',
    levels: {
      consulta: { hint: 'Auditorias, não conformidades, bundles, treinamentos e insumos', permissions: ['quality:view'] },
      registro: { hint: 'Achados, evidências e andamento de ações de auditorias; checklists; não conformidades', permissions: ['quality:audit:execute', 'quality:bundle:record', 'nc:record'] },
    },
  },
  indicadores: {
    label: 'Indicadores e relatórios', module: 'ccih',
    levels: {
      consulta: { hint: 'Painel, indicadores e relatórios', permissions: ['dashboard:view', 'indicators:view', 'reports:view'] },
      exportacao: { hint: 'Exportação de dados agregados (registrada no log)', permissions: ['export:aggregate'] },
    },
  },
  alertas: {
    label: 'Alertas', module: null,
    levels: { consulta: { hint: 'Ver os alertas das áreas acessíveis', permissions: ['alerts:view'] } },
  },
};

/** Permissions of one marker; "Registro/edição" and "Exportação" include the consultation of the area. */
export function apprenticeMarkerPermissions(area: ApprenticeArea, level: ApprenticeLevel): Permission[] {
  const a = APPRENTICE_AREAS[area].levels;
  const own = a[level]?.permissions ?? [];
  return level === 'consulta' ? own : [...new Set([...(a.consulta?.permissions ?? []), ...own])];
}

/** Which markers are fully present in a set of grants (to show the current choice). */
export function apprenticeMarkersOf(grants: readonly string[]): Array<[ApprenticeArea, ApprenticeLevel]> {
  const out: Array<[ApprenticeArea, ApprenticeLevel]> = [];
  for (const area of Object.keys(APPRENTICE_AREAS) as ApprenticeArea[]) {
    for (const level of Object.keys(APPRENTICE_AREAS[area].levels) as ApprenticeLevel[]) {
      if (apprenticeMarkerPermissions(area, level).every((p) => grants.includes(p))) out.push([area, level]);
    }
  }
  return out;
}

/** Who is acting on accounts: the permissions of the manager and whether it is the creator account. */
export interface Grantor { permissions: readonly string[]; isFounder: boolean }

const has = (g: Grantor, p: Permission) => g.permissions.includes(p);
/** Modules whose users this grantor administers (a system administrator: all). */
export function managedModules(g: Grantor): Array<'ccih' | 'cme'> | 'all' | null {
  if (has(g, 'users:manage')) return 'all';
  const out: Array<'ccih' | 'cme'> = [];
  if (has(g, 'users:manage:ccih')) out.push('ccih');
  if (has(g, 'users:manage:cme')) out.push('cme');
  return out.length ? out : null;
}

/**
 * Functions a grantor may give. Only the creator account gives "Administrador do sistema"; a module
 * administrator gives the operational functions of its own module and the Jovem Aprendiz, never
 * another administrator.
 */
export function assignableRoles(g: Grantor): RoleCode[] {
  const scope = managedModules(g);
  if (!scope) return [];
  if (scope === 'all') return (Object.keys(ROLE_LABEL) as RoleCode[]).filter((r) => r !== 'admin' || g.isFounder);
  const out: RoleCode[] = [];
  if (scope.includes('ccih')) out.push('enf_ccih', 'tec_ccih');
  if (scope.includes('cme')) out.push('cme', 'tec_cme');
  return [...out, 'aprendiz'];
}

/** Whether a grantor may change an account holding these functions (never the creator account, and admins only through the creator). */
export function canManageAccount(g: Grantor, target: { roles: readonly RoleCode[]; isFounder: boolean }): boolean {
  if (target.isFounder) return false;
  if (target.roles.includes('admin')) return g.isFounder;
  const allowed = assignableRoles(g);
  return target.roles.every((r) => allowed.includes(r));
}

/** Permissions a grantor may give individually to an account with these functions. */
export function grantablePermissions(g: Grantor, targetRoles: readonly RoleCode[]): Permission[] {
  const scope = managedModules(g);
  if (!scope) return [];
  let list: Permission[] = scope === 'all'
    ? ALL_PERMISSIONS.filter((p) => !NEVER_GRANTED_INDIVIDUALLY.includes(p))
    : [...new Set(scope.flatMap((m) => DELEGABLE[m]))];
  if (targetRoles.includes('aprendiz')) list = list.filter((p) => APPRENTICE_ALLOWED.includes(p));
  return list;
}

/** Areas whose apprentice markers a grantor may use (a module administrator: its module; alerts for any manager). */
export function grantableApprenticeAreas(g: Grantor): ApprenticeArea[] {
  const scope = managedModules(g);
  if (!scope) return [];
  return (Object.keys(APPRENTICE_AREAS) as ApprenticeArea[]).filter((k) => {
    const m = APPRENTICE_AREAS[k].module;
    return scope === 'all' || m === null || (scope as string[]).includes(m);
  });
}

export function hasPermission(granted: readonly string[], required: Permission): boolean {
  return granted.includes(required);
}

export function isPermission(value: string): value is Permission {
  return value in PERMISSIONS;
}
