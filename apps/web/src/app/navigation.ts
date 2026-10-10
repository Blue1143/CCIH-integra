import type { Permission } from '@ccih/domain';

/** Main navigation. Modules not yet built say so and name the roadmap phase — no fake screens. */
export interface NavItem {
  path: string;
  label: string;
  /** Shown when the profile has any of these (the API enforces the same rule). */
  permissions: Permission[];
  /** Roadmap phase that delivers the module; null = available now. */
  phase: number | null;
  summary: string;
  planned?: string[];
}

export interface NavGroup {
  label: string | null;
  items: NavItem[];
}

export const NAVIGATION: NavGroup[] = [
  {
    label: null,
    items: [{ path: '/', permissions: ['dashboard:view'], label: 'Visão Geral', phase: null, summary: 'Painel executivo da CCIH.' }],
  },
  {
    label: 'Vigilância',
    items: [
      { path: '/vigilancia', permissions: ['iras:view'], label: 'Vigilância IRAS', phase: null, summary: 'Suspeitas, investigações, confirmações e descartes de IRAS.' },
      { path: '/pacientes', permissions: ['patient:view'], label: 'Pacientes', phase: null, summary: 'Internações, dispositivos, culturas, cirurgias, IRAS e evolução CCIH do paciente.' },
      { path: '/censo', permissions: ['patient:view', 'indicators:view'], label: 'Censo diário', phase: null, summary: 'Ocupação e denominadores reais (paciente-dia, dispositivo-dia) e consolidação de indicadores.' },
      { path: '/cirurgias', permissions: ['surgery:view'], label: 'Cirurgias', phase: null, summary: 'Registro cirúrgico, risco, antibioticoprofilaxia e vigilância de ISC.' },
      { path: '/microbiologia', permissions: ['micro:view'], label: 'Microbiologia', phase: null, summary: 'Culturas, microrganismos, antibiograma e perfis de resistência.' },
      { path: '/antimicrobianos', permissions: ['atm:view'], label: 'Antimicrobianos', phase: 6, summary: 'Stewardship: prescrições, revisões e alertas de apoio à decisão.',
        planned: ['Registro de prescrição e revisão CCIH', 'Alertas de terapia prolongada e descalonamento', 'DDD por setor'] },
    ],
  },
  {
    label: 'Prevenção e qualidade',
    items: [
      { path: '/bundles', permissions: ['quality:view'], label: 'Bundles e higiene das mãos', phase: null, summary: 'Auditoria de bundles configuráveis e observação de higiene das mãos, com adesão e Pareto.' },
      { path: '/auditorias', permissions: ['quality:view'], label: 'Auditorias', phase: null, summary: 'Auditorias, não conformidades e planos de ação (5W2H).' },
      { path: '/treinamentos', permissions: ['quality:view'], label: 'Treinamentos', phase: null, summary: 'Treinamentos, presença, cobertura e vencimentos.' },
      { path: '/insumos', permissions: ['quality:view'], label: 'Insumos', phase: null, summary: 'Estoque por lote, validade e cobertura de insumos de prevenção.' },
    ],
  },
  {
    label: 'CME',
    items: [
      { path: '/cme', permissions: ['cme:view'], label: 'CME', phase: null, summary: 'Ciclos, testes (Bowie-Dick, IQ classes 1–6, IB) e liberação de cargas.' },
      { path: '/cme/estacao', permissions: ['cme:scan'], label: 'Estação de leitura', phase: null, summary: 'Leitura de código de barras na entrada, no processamento e na saída do CME.' },
      { path: '/rastreabilidade', permissions: ['cme:view'], label: 'Rastreabilidade', phase: null, summary: 'Lote → ciclo → carga → material → cirurgia → paciente, e o caminho inverso.' },
    ],
  },
  {
    label: 'Gestão',
    items: [
      { path: '/indicadores', permissions: ['indicators:view'], label: 'Indicadores', phase: null, summary: 'Catálogo de indicadores com fórmula, fonte e meta.' },
      { path: '/relatorios', permissions: ['reports:view'], label: 'Relatórios', phase: 7, summary: 'Relatórios com filtros, impressão, PDF e CSV.' },
      { path: '/alertas', permissions: ['alerts:view'], label: 'Alertas', phase: null, summary: 'Central de alertas com prioridade, responsável e controle de excesso de alertas.' },
      { path: '/admin', permissions: ['config:view', 'users:view', 'users:manage', 'users:manage:ccih', 'users:manage:cme', 'audit:view', 'audit:view:module'], label: 'Administração', phase: null, summary: 'Metas, parâmetros, referências, política da CME, usuários, perfis e log de auditoria.' },
    ],
  },
];

export const ALL_NAV_ITEMS = NAVIGATION.flatMap((g) => g.items);
